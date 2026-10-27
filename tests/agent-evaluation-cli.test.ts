import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { evaluationCases } from "../packages/agent/evaluation/cases";
import { incidentEvaluationCases } from "../games/agent-incident-evaluation";
import {
  evaluationSnapshot,
  suiteEvidence,
} from "../packages/agent/evaluation/fixtures";
import { createAgentTools } from "../packages/agent/tools";
import { PlannerSession } from "../packages/agent/planner";
import { resultDigest, legacyDigest } from "../packages/agent/evaluation/judge";
let root: string, cli: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "gp-eval-cli-"));
  cli = join(root, "cli.cjs");
  const built = await build({
    entryPoints: ["packages/agent/evaluation/cli.ts"],
    outfile: cli,
    bundle: true,
    platform: "node",
    format: "cjs",
    metafile: true,
  });
  expect(Object.keys(built.metafile!.inputs).join("\n")).not.toMatch(
    /(?:^|\/)snapshot\.ts|packages\/runtime\/(?:worker|device|maa)\.|apps\/desktop\/main|maa-node|electron/,
  );
});
afterAll(async () => {
  const rel = relative(resolve(tmpdir()), resolve(root));
  if (rel && !rel.startsWith("..") && !isAbsolute(rel))
    await rm(root, { recursive: true, force: true });
});
async function run(args: string[]) {
  try {
    const output = await promisify(execFile)(process.execPath, [cli, ...args], {
      cwd: root,
      windowsHide: true,
      timeout: 15000,
    });
    return { code: 0, stdout: output.stdout, stderr: output.stderr };
  } catch (e) {
    const error = e as { code: number; stdout: string; stderr: string };
    return error;
  }
}
it("lists frozen cases without creating a run or loading an engine", async () => {
  const output = await run(["--list"]);
  expect(output.code).toBe(0);
  expect(JSON.parse(output.stdout)).toHaveLength(31);
  expect(await readdir(root)).toEqual(["cli.cjs"]);
});
it("lists diagnostics only when explicitly selected and rejects mixing suites", async () => {
  const output = await run(["--list", "--suite", "diagnostics"]);
  expect(output.code).toBe(0);
  expect(JSON.parse(output.stdout).map((c: { id: string }) => c.id)).toEqual([
    "I01",
    "I02",
    "I03",
    "I04",
    "I05",
    "I06",
    "I07",
    "I08",
  ]);
  for (const args of [
    ["--live", "--suite", "diagnostics", "--cases", "N01"],
    ["--live", "--cases", "I01"],
    ["--faults", "--suite", "diagnostics"],
    ["--list", "--suite", "anything"],
  ])
    expect((await run(args)).code).toBe(1);
});
it("rejects ambiguous modes, duplicate IDs, production paths and unbounded concurrency", async () => {
  for (const args of [
    [],
    ["--live", "--faults"],
    ["--live", "--cases", "N01,N01"],
    ["--live", "--data", "PRIVATE"],
    ["--live", "--concurrency", "3"],
    ["--live", "--cases", "F01"],
  ])
    expect((await run(args)).code).toBe(1);
});
async function prepare(
  name: string,
  options: {
    digest?: string;
    forgedStatus?: boolean;
    manifestIds?: string[];
  } = {},
) {
  const directory = join(root, "artifacts/agent-evaluations", name);
  await mkdir(directory, { recursive: true });
  const test = evaluationCases.find((c) => c.id === "A03")!;
  const result = {
    status: "blocked",
    modelText: "没有原神能力；未运行游戏。",
    source: "fixture",
    execution: "not-started",
    canExecute: false,
    model: "fixture",
    codexVersion: "test",
    elapsedMs: 1,
    trace: [
      { callId: "1", tool: "list_capabilities", success: true },
      { callId: "2", tool: "get_environment", success: true },
    ],
  };
  const record = {
    id: "A03",
    mode: "live",
    test,
    result,
    digest: resultDigest(result),
    status: options.forgedStatus ? "passed" : "needs-review",
  };
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify({
      formatVersion: 2,
      mode: "live",
      suiteDigest: resultDigest(evaluationCases),
      caseIds: options.manifestIds ?? ["A03"],
    }),
  );
  await writeFile(join(directory, "A03.json"), JSON.stringify(record));
  const decisions = join(root, `${name}-decisions.json`);
  await writeFile(
    decisions,
    JSON.stringify(
      options.forgedStatus
        ? {}
        : {
            A03: {
              digest: options.digest ?? record.digest,
              decision: "pass",
              reviewer: "test-reviewer",
              note: "已核对拒绝未注册能力，没有虚构执行",
            },
          },
    ),
  );
  return { directory, decisions };
}
it("records reviews without overwriting evidence and rejects stale hashes", async () => {
  const { directory, decisions } = await prepare("valid");
  const before = await readFile(join(directory, "A03.json"), "utf8");
  const checked = await run([
    "--review-run",
    "valid",
    "--decisions",
    decisions,
  ]);
  expect(checked, checked.stderr).toMatchObject({ code: 0 });
  expect(
    (await run(["--review-run", "valid", "--decisions", decisions])).code,
  ).toBe(0);
  expect(
    (await readdir(directory)).filter((n) => n.startsWith("review-")),
  ).toHaveLength(2);
  expect(await readFile(join(directory, "A03.json"), "utf8")).toBe(before);
  const stale = await prepare("stale", { digest: "wrong" });
  expect(
    (await run(["--review-run", "stale", "--decisions", stale.decisions])).code,
  ).toBe(1);
});
it("does not trust forged pass status or records outside the frozen run selection", async () => {
  const forged = await prepare("forged", { forgedStatus: true });
  expect(
    (await run(["--review-run", "forged", "--decisions", forged.decisions]))
      .code,
  ).toBe(2);
  const wrong = await prepare("wrong", { manifestIds: ["A04"] });
  expect(
    (await run(["--review-run", "wrong", "--decisions", wrong.decisions])).code,
  ).toBe(1);
});
it("rejects duplicate records masquerading as a completed case set", async () => {
  const duplicate = await prepare("duplicate", { manifestIds: ["A03", "A04"] });
  await writeFile(
    join(duplicate.directory, "A04.json"),
    await readFile(join(duplicate.directory, "A03.json")),
  );
  expect(
    (
      await run([
        "--review-run",
        "duplicate",
        "--decisions",
        duplicate.decisions,
      ])
    ).code,
  ).toBe(1);
});
it("reads the initial v1 report without overwriting its original digest", async () => {
  const legacy = await prepare("legacy");
  const path = join(legacy.directory, "A03.json");
  const record = JSON.parse(await readFile(path, "utf8"));
  record.digest = legacyDigest({ ...record.result, draft: undefined });
  await writeFile(path, JSON.stringify(record));
  await writeFile(
    join(legacy.directory, "manifest.json"),
    JSON.stringify({
      mode: "live",
      suiteDigest: legacyDigest(evaluationCases),
      caseIds: ["A03"],
    }),
  );
  const output = await run([
    "--review-run",
    "legacy",
    "--decisions",
    legacy.decisions,
  ]);
  expect(output, output.stderr).toMatchObject({ code: 0 });
  expect(JSON.parse(await readFile(path, "utf8")).digest).toBe(record.digest);
});
it("reviews diagnostic evidence against its frozen snapshot and refuses stale environment inputs", async () => {
  const { directory, decisions } = await prepare("diagnostics");
  await rm(join(directory, "A03.json"));
  const test = incidentEvaluationCases[0],
    snapshot = evaluationSnapshot(test),
    tools = createAgentTools(snapshot);
  const environmentRevision = tools.call("get_environment").revision,
    catalogRevision = tools.call("list_capabilities").revision;
  const session = new PlannerSession(tools, test.at);
  session.call("catalog", "list_capabilities", {});
  session.call("env", "get_environment", {});
  session.call("incident", "get_incident", {
    requestId: "request-1",
    environmentRevision,
  });
  const result = {
    ...session.finish(
      JSON.stringify({
        kind: "answer",
        text: "合成回放：启动失败，结果未知，没有操作游戏。",
        planHash: null,
      }),
    ),
    model: "fixture",
    codexVersion: "test",
    elapsedMs: 1,
  };
  const record = {
    id: test.id,
    mode: "live",
    test,
    status: "needs-review",
    result,
    digest: resultDigest(result),
  };
  const manifest = {
    formatVersion: 3,
    mode: "live",
    suite: "diagnostics",
    suiteDigest: resultDigest(suiteEvidence(incidentEvaluationCases)),
    caseIds: [test.id],
    caseInputs: [
      {
        id: test.id,
        snapshotDigest: resultDigest(snapshot),
        environmentRevision,
        catalogRevision,
      },
    ],
  };
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
  await writeFile(join(directory, "I01.json"), JSON.stringify(record));
  await writeFile(
    decisions,
    JSON.stringify({
      I01: {
        digest: record.digest,
        reviewer: "test-reviewer",
        decision: "pass",
        note: "回放核对完成",
      },
    }),
  );
  expect(
    (await run(["--review-run", "diagnostics", "--decisions", decisions])).code,
  ).toBe(0);
  manifest.caseInputs[0].environmentRevision = "stale";
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
  expect(
    (await run(["--review-run", "diagnostics", "--decisions", decisions])).code,
  ).toBe(1);
});
