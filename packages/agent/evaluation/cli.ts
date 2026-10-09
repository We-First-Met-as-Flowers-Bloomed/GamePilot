import {
  mkdir,
  writeFile,
  readFile,
  readdir,
  realpath,
} from "node:fs/promises";
import { resolve, join, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { evaluationSuite } from "./cases";
import { evaluationSnapshot, suiteEvidence } from "./fixtures";
import { runEvaluation, type EvaluationRecord } from "./runner";
import { judgeResult, resultDigest, legacyDigest, reviewResult } from "./judge";
import type { Review, EvaluationCase } from "./types";
import { createAgentTools } from "../tools";
import { planWithCodex, supportedCodexVersions } from "../codex/adapter";
import { findCodexExecutable } from "../codex/discovery";
import { AgentToolError } from "../../protocol/agent";
const root = resolve("artifacts/agent-evaluations");
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
const writeNew = (path: string, value: unknown) =>
  writeFile(path, json(value), { flag: "wx" });
function caseInputs(cases: EvaluationCase[], ids: string[]) {
  return ids.map((id) => {
    const snapshot = evaluationSnapshot(cases.find((c) => c.id === id)!);
    const tools = createAgentTools(snapshot);
    return {
      id,
      snapshotDigest: resultDigest(snapshot),
      catalogRevision: tools.call("list_capabilities").revision,
      environmentRevision: tools.call("get_environment").revision,
    };
  });
}
async function main() {
  const args = process.argv.slice(2);
  const values = new Map<string, string>();
  let mode = "";
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (["--list", "--live", "--faults"].includes(key) && !mode) {
      mode = key;
      continue;
    }
    if (
      ![
        "--suite",
        "--cases",
        "--concurrency",
        "--review-run",
        "--decisions",
      ].includes(key) ||
      values.has(key) ||
      !args[i + 1] ||
      args[i + 1].startsWith("--")
    )
      throw Error(
        "参数无效：--list [--suite diagnostics] | --live [--suite diagnostics] [--cases 用例ID] [--concurrency 1或2] | --faults | --review-run 目录名 --decisions 文件",
      );
    values.set(key, args[++i]);
  }
  if (values.has("--review-run")) {
    if (mode || values.size !== 2 || !values.has("--decisions"))
      throw Error("复核参数无效");
    const directory = await realpath(
      resolve(root, values.get("--review-run")!),
    );
    const rel = relative(await realpath(root), directory);
    if (!rel || rel.startsWith("..") || isAbsolute(rel))
      throw Error("复核目录须位于评测目录内");
    const reviews = JSON.parse(
      await readFile(values.get("--decisions")!, "utf8"),
    ) as Record<string, Review>;
    const records: EvaluationRecord[] = [];
    for (const file of (await readdir(directory)).filter((n) =>
      /^[NACDI]\d{2}\.json$/.test(n),
    )) {
      const record = JSON.parse(
        await readFile(join(directory, file), "utf8"),
      ) as EvaluationRecord;
      if (
        file !== `${record.id}.json` ||
        records.some((r) => r.id === record.id)
      )
        throw Error("记录编号与文件名不符或重复");
      records.push(record);
    }
    if (
      !records.length ||
      !reviews ||
      typeof reviews !== "object" ||
      Array.isArray(reviews) ||
      Object.keys(reviews).some((id) => !records.some((r) => r.id === id))
    )
      throw Error("复核记录不匹配");
    const manifest = JSON.parse(
      await readFile(join(directory, "manifest.json"), "utf8"),
    );
    const legacy = manifest.formatVersion === undefined;
    const evaluationCases = evaluationSuite(manifest.suite ?? "planning");
    if (
      (![2, 3].includes(manifest.formatVersion) && !legacy) ||
      (manifest.formatVersion === 3) !== (manifest.suite === "diagnostics")
    )
      throw Error("报告版本不支持");
    if (
      manifest.suiteDigest !==
      (legacy
        ? legacyDigest(evaluationCases)
        : resultDigest(suiteEvidence(evaluationCases)))
    )
      throw Error("用例版本变化，请重新运行评测");
    if (
      manifest.mode !== "live" ||
      !Array.isArray(manifest.caseIds) ||
      !manifest.caseIds.length ||
      new Set(manifest.caseIds).size !== manifest.caseIds.length ||
      manifest.caseIds.some(
        (id: string) =>
          !evaluationCases.some((c) => c.id === id && c.mode === "live"),
      ) ||
      records.some((r) => !manifest.caseIds.includes(r.id))
    )
      throw Error("记录不属于冻结的本轮用例");
    if (
      manifest.formatVersion === 3 &&
      resultDigest(manifest.caseInputs) !==
        resultDigest(caseInputs(evaluationCases, manifest.caseIds))
    )
      throw Error("冻结的诊断输入或环境版本不符");
    const results = records.map((r) => {
      if (!r.result) {
        if (!["error", "skipped"].includes(r.status) || reviews[r.id])
          throw Error("缺少可复核结果");
        return { id: r.id, status: r.status };
      }
      // v1 initial evaluation hashed an own draft:undefined field that JSON omitted.
      const validDigest =
        r.digest === resultDigest(r.result) ||
        (legacy &&
          r.result.status !== "draft" &&
          r.digest === legacyDigest({ ...r.result, draft: undefined }));
      if (!validDigest) throw Error("原始结果hash不符");
      const frozen = evaluationCases.find((c) => c.id === r.id)!;
      if (resultDigest(r.test) !== resultDigest(frozen))
        throw Error("冻结输入不符");
      if (!reviews[r.id]) return { id: r.id, ...judgeResult(frozen, r.result) };
      return {
        id: r.id,
        ...reviewResult(judgeResult(frozen, r.result), r.result, reviews[r.id]),
        review: reviews[r.id],
      };
    });
    const output = {
      reviewedAt: new Date().toISOString(),
      mode: "live",
      results,
      complete:
        results.length === manifest.caseIds.length &&
        results.every((r) => r.status === "passed"),
    };
    const file = join(directory, `review-${randomUUID()}.json`);
    await writeNew(file, output);
    console.log(json({ file, ...output }));
    if (!output.complete) process.exitCode = 2;
    return;
  }
  if (!mode || values.has("--decisions"))
    throw Error("必须明确选择--list、--live或--faults");
  const suite = values.get("--suite") ?? "planning";
  const evaluationCases = evaluationSuite(suite);
  if (
    (mode === "--faults" && values.size) ||
    (mode === "--list" && [...values.keys()].some((k) => k !== "--suite"))
  )
    throw Error("该模式不接受额外参数");
  if (mode === "--list") {
    console.log(json(evaluationCases));
    return;
  }
  const selected = values.has("--cases")
    ? values.get("--cases")!.split(",")
    : evaluationCases.filter((c) => c.mode === "live").map((c) => c.id);
  if (
    new Set(selected).size !== selected.length ||
    selected.some(
      (id) => !evaluationCases.some((c) => c.id === id && c.mode === "live"),
    )
  )
    throw Error("用例ID无效或重复");
  const concurrency = Number(values.get("--concurrency") ?? 1);
  if (![1, 2].includes(concurrency)) throw Error("并发只能为1或2");
  const directory = join(
    root,
    `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`,
  );
  await mkdir(directory, { recursive: true });
  const tools = createAgentTools(
    evaluationSnapshot(evaluationCases.find((c) => c.id === selected[0])!),
  );
  await writeNew(join(directory, "manifest.json"), {
    formatVersion: suite === "diagnostics" ? 3 : 2,
    ...(suite === "diagnostics"
      ? { suite, caseInputs: caseInputs(evaluationCases, selected) }
      : {}),
    buildDigest: resultDigest(await readFile(__filename, "utf8")),
    mode: mode === "--live" ? "live" : "fault-injection",
    suiteDigest: resultDigest(suiteEvidence(evaluationCases)),
    cases: evaluationCases,
    caseIds:
      mode === "--live"
        ? selected
        : evaluationCases
            .filter((c) => c.mode === "fault-injection")
            .map((c) => c.id),
    catalogRevision: tools.call("list_capabilities").revision,
    environmentRevision: tools.call("get_environment").revision,
    supportedCodexVersions,
    concurrency,
    startedAt: new Date().toISOString(),
  });
  console.log(json({ directory, mode }));
  if (mode === "--faults") {
    let exitCode = 0;
    try {
      await promisify(execFile)(
        process.execPath,
        [
          resolve("node_modules/vitest/vitest.mjs"),
          "run",
          "tests/agent-evaluation-faults.test.ts",
          "--reporter=json",
          `--outputFile=${join(directory, "vitest.json")}`,
        ],
        { windowsHide: true, timeout: 90000, maxBuffer: 1024 * 1024 },
      );
    } catch {
      exitCode = 1;
    }
    const raw = JSON.parse(
      await readFile(join(directory, "vitest.json"), "utf8"),
    );
    const results = raw.testResults
      .flatMap(
        (r: { assertionResults: { title: string; status: string }[] }) =>
          r.assertionResults,
      )
      .map((r: { title: string; status: string }) => ({
        id: r.title.slice(0, 3),
        status: r.status,
      }));
    const complete =
      exitCode === 0 &&
      results.length === 6 &&
      evaluationCases
        .filter((c) => c.mode === "fault-injection")
        .every((c) =>
          results.some(
            (r: { id: string; status: string }) =>
              r.id === c.id && r.status === "passed",
          ),
        );
    await writeNew(join(directory, "summary.json"), {
      mode: "fault-injection",
      complete,
      results,
    });
    console.log(json({ mode: "fault-injection", complete, results }));
    if (!complete) process.exitCode = 1;
    return;
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    const executable = await findCodexExecutable({ signal: controller.signal });
    const records = await runEvaluation(
      selected.map((id) => evaluationCases.find((c) => c.id === id)!),
      {
        concurrency,
        signal: controller.signal,
        run: (test, signal, onProgress) =>
          planWithCodex(createAgentTools(evaluationSnapshot(test)), {
            executable,
            prompt: test.prompt,
            at: test.at,
            signal,
            onProgress,
          }),
        save: async (record) => {
          await writeNew(join(directory, `${record.id}.json`), record);
          console.log(
            json({
              id: record.id,
              status: record.status,
              failures: record.verdict?.failures,
              error: record.error?.code,
            }),
          );
        },
      },
    );
    const summary = {
      mode: "live",
      finishedAt: new Date().toISOString(),
      counts: Object.fromEntries(
        ["passed", "needs-review", "failed", "error", "skipped"].map((s) => [
          s,
          records.filter((r) => r.status === s).length,
        ]),
      ),
      complete: records.length === selected.length,
      reviewed: false,
    };
    await writeNew(join(directory, "summary.json"), summary);
    console.log(json(summary));
    if (
      records.some(
        (r) =>
          r.status === "failed" ||
          r.status === "error" ||
          r.status === "skipped",
      )
    )
      process.exitCode = 1;
    else process.exitCode = 2; // Structurally valid output still needs text review.
  } catch (error) {
    await writeNew(join(directory, "startup-error.json"), {
      code: error instanceof AgentToolError ? error.code : "EVALUATION_FAILED",
      message: "评测未完成；检查现有逐条证据",
    });
    throw error;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
void main().catch((error) => {
  console.error(
    error instanceof AgentToolError
      ? error.code
      : "评测失败：" + (error instanceof Error ? error.message : "未知错误"),
  );
  process.exitCode = 1;
});
