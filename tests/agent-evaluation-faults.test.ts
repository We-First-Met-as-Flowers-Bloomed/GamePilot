import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { StdioRpc, type PlannerRpc } from "../packages/agent/codex/rpc";
import { runPlannerProtocol } from "../packages/agent/codex/adapter";
import { PlannerSession } from "../packages/agent/planner";
import { createAgentTools } from "../packages/agent/tools";
import { createFixtureSnapshot } from "../packages/agent/fixture";
import { PlannerService } from "../apps/desktop/main/agent-planner";
import { AgentToolError } from "../packages/protocol/agent";
import { evaluationCases } from "../packages/agent/evaluation/cases";
let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "gp-eval-fault-"));
});
afterAll(async () => {
  const rel = relative(resolve(tmpdir()), resolve(root));
  if (rel && !rel.startsWith("..") && !isAbsolute(rel))
    await rm(root, { recursive: true, force: true });
});
async function wrapper(mode: string, code: string, turnStarted: boolean) {
  const prompt = join(root, `${mode}.txt`),
    report = join(root, `${mode}.json`);
  await writeFile(prompt, evaluationCases[0].prompt);
  let output: string | undefined;
  try {
    await promisify(execFile)(
      process.execPath,
      [
        resolve("tests/helpers/codex-wrapper-driver.cjs"),
        resolve("scripts/agent/plan.mjs"),
        resolve("tests/helpers/codex-fixture.cjs"),
        join(root, "fake-codex.exe"),
        prompt,
        report,
        mode,
      ],
      { windowsHide: true, timeout: 15000 },
    );
  } catch (e) {
    const error = e as { code: number; stdout: string; stderr: string };
    expect(error.code).toBe(1);
    expect(error.stderr).toBe("");
    output = error.stdout;
  }
  expect(output).toBeTruthy();
  expect(JSON.parse(output!)).toMatchObject({
    ok: false,
    canExecute: false,
    execution: "not-started",
    error: { code },
  });
  expect(JSON.parse(await readFile(report, "utf8"))).toMatchObject({
    spawned: 2,
    active: [],
    extraCliChildren: 0,
    turnStarted,
  });
}
it("F01 cancellation waits for actual wrapper subprocess cleanup", async () => {
  await wrapper("cancel", "CANCELLED", true);
}, 20000);
it("F02 injected missing authentication never starts a model turn", async () => {
  await wrapper("auth", "AUTH_REQUIRED", false);
}, 20000);
it("F03 injected quota event is a failure, not a completed draft", async () => {
  const tools = createAgentTools(createFixtureSnapshot());
  const rpc: PlannerRpc = {
    request: async <T>(method: string) =>
      (method === "thread/start"
        ? { thread: { id: "thread" }, model: "fault-injection" }
        : { turn: { id: "turn" } }) as T,
    respond: () => {},
    next: async () => ({
      method: "turn/completed",
      params: {
        threadId: "thread",
        turn: {
          id: "turn",
          status: "failed",
          error: { codexErrorInfo: "usageLimitExceeded" },
        },
      },
    }),
  };
  await expect(
    runPlannerProtocol(
      rpc,
      new PlannerSession(tools, evaluationCases[0].at),
      tools,
      { prompt: evaluationCases[0].prompt, cwd: root },
    ),
  ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
});
it("F04 child disconnect rejects the request and close confirms exit", async () => {
  const rpc = new StdioRpc(
    process.execPath,
    ["-e", "process.stdin.once('data',()=>process.exit(3))"],
    root,
  );
  try {
    await expect(rpc.request("turn/start", {})).rejects.toMatchObject({
      code: "CODEX_EXITED",
    });
  } finally {
    await expect(rpc.close()).resolves.toBeUndefined();
  }
});
it("F05 silent child times out and is cleaned up", async () => {
  const rpc = new StdioRpc(
    process.execPath,
    ["-e", "process.stdin.resume()"],
    root,
  );
  try {
    await expect(rpc.request("turn/start", {}, 100)).rejects.toMatchObject({
      code: "TIMEOUT",
    });
  } finally {
    await expect(rpc.close()).resolves.toBeUndefined();
  }
});
it("F06 injected shutdown failure is not hidden by cancellation and blocks admission", async () => {
  let begin!: () => void;
  const running = new Promise<void>((resolve) => {
    begin = resolve;
  });
  const service = new PlannerService({
    find: async () => "fixture",
    run: async ({ signal }) => {
      begin();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      throw new AgentToolError("SHUTDOWN_FAILED", "注入清理失败");
    },
  });
  service.start({
    prompt: evaluationCases[0].prompt,
    at: evaluationCases[0].at,
  });
  await running;
  await service.close();
  expect(service.snapshot()).toMatchObject({
    status: "failed",
    error: { code: "SHUTDOWN_FAILED" },
  });
  expect(() =>
    service.start({ prompt: "再次开始", at: evaluationCases[0].at }),
  ).toThrow(/关闭/);
});
it("F07 concurrent wrapper builds each import a complete independent bundle", async () => {
  const results = await Promise.all(
    Array.from({ length: 8 }, async (_, index) => {
      const report = join(root, `parallel-build-${index}.json`);
      try {
        await promisify(execFile)(
          process.execPath,
          [
            resolve("tests/helpers/planner-build-driver.cjs"),
            resolve("scripts/agent/plan.mjs"),
            report,
          ],
          { windowsHide: true, timeout: 15000 },
        );
        throw new Error("expected argument rejection");
      } catch (failure) {
        return {
          failure: failure as { code: number; stdout: string; stderr: string },
          report,
        };
      }
    }),
  );
  const bundlePaths: string[] = [];
  for (const { failure: result, report } of results) {
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      canExecute: false,
      execution: "not-started",
      error: { code: "INVALID_ARGUMENTS" },
    });
    const loaded = JSON.parse(await readFile(report, "utf8"));
    expect(loaded.bundles).toHaveLength(1);
    bundlePaths.push(loaded.bundles[0]);
  }
  expect(new Set(bundlePaths).size).toBe(results.length);
  for (const path of bundlePaths)
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
}, 20000);
