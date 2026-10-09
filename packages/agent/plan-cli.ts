import { readFile, stat } from "node:fs/promises";
import { AgentToolError, agentDate } from "../protocol/agent";
import { createAgentTools } from "./tools";
import { createFixtureSnapshot } from "./fixture";
import { planWithCodex } from "./codex/adapter";

async function main() {
  const args = process.argv.slice(2);
  const values = new Map<string, string>();
  let fixture = false;
  const invalid = () =>
    new AgentToolError(
      "INVALID_ARGUMENTS",
      "用法：--fixture --codex 绝对路径 --prompt-file 需求文件 --at 带时区的时间 [--model 模型]",
    );
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === "--fixture" && !fixture) {
      fixture = true;
      continue;
    }
    if (
      !["--codex", "--prompt-file", "--at", "--model"].includes(key) ||
      values.has(key) ||
      !args[i + 1] ||
      args[i + 1].startsWith("--")
    )
      throw invalid();
    values.set(key, args[++i]);
  }
  if (
    !fixture ||
    !values.has("--codex") ||
    !values.has("--prompt-file") ||
    !values.has("--at")
  )
    throw invalid();
  const at = agentDate(values.get("--at"));
  let prompt: string;
  try {
    const path = values.get("--prompt-file")!;
    if ((await stat(path)).size > 48 * 1024) throw new Error();
    prompt = (await readFile(path, "utf8")).replace(/^\uFEFF/, "");
  } catch {
    throw new AgentToolError(
      "PROMPT_READ_FAILED",
      "无法读取需求文件或文件超过48KiB",
    );
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    const result = await planWithCodex(
      createAgentTools(createFixtureSnapshot()),
      {
        executable: values.get("--codex")!,
        prompt,
        at,
        model: values.get("--model"),
        signal: controller.signal,
      },
    );
    process.stdout.write(JSON.stringify({ ok: true, ...result }) + "\n");
    process.exitCode =
      result.status === "blocked" || result.status === "question" ? 2 : 0;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
void main().catch((error) => {
  process.stdout.write(
    JSON.stringify({
      ok: false,
      source: "fixture",
      execution: "not-started",
      canExecute: false,
      error: {
        code: error instanceof AgentToolError ? error.code : "PLANNER_FAILED",
        message:
          error instanceof AgentToolError
            ? error.message
            : "规划失败，未执行游戏任务",
      },
    }) + "\n",
  );
  process.exitCode = 1;
});
