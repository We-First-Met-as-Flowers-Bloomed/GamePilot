import { readFile, stat } from "node:fs/promises";
import {
  agentToolNames,
  AgentToolError,
  type AgentToolName,
} from "../protocol/agent";
import { createFixtureSnapshot } from "./fixture";
import { readAgentSnapshot } from "./snapshot";
import { createAgentTools } from "./tools";

async function main() {
  const argv = process.argv.slice(2);
  const options = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (
      !["--fixture", "--data", "--tool", "--input"].includes(flag) ||
      options.has(flag)
    )
      throw new AgentToolError(
        "CLI_USAGE",
        "参数无效或重复；使用 --fixture 或 --data 目录、--tool 工具名、可选 --input JSON文件",
      );
    if (flag === "--fixture") options.set(flag, true);
    else {
      const value = argv[++i];
      if (!value || value.startsWith("--"))
        throw new AgentToolError("CLI_USAGE", "参数缺少值");
      options.set(flag, value);
    }
  }
  if (options.has("--fixture") === options.has("--data"))
    throw new AgentToolError(
      "CLI_USAGE",
      "必须显式选择 --fixture 或 --data，不能同时选择",
    );
  const tool = options.get("--tool");
  if (
    typeof tool !== "string" ||
    !agentToolNames.includes(tool as AgentToolName)
  )
    throw new AgentToolError(
      "UNKNOWN_TOOL",
      "仅支持已注册的只读查询与计划编译工具；故障导出使用 agent:incident",
    );
  let input: unknown = {};
  const inputPath = options.get("--input");
  if (typeof inputPath === "string") {
    try {
      if ((await stat(inputPath)).size > 65536) throw Error("oversized");
      input = JSON.parse(
        (await readFile(inputPath, "utf8")).replace(/^\uFEFF/, ""),
      );
    } catch {
      throw new AgentToolError(
        "INVALID_INPUT",
        "输入文件不可读取、超过64KiB或不是有效JSON",
      );
    }
  }
  const snapshot = options.has("--fixture")
    ? createFixtureSnapshot()
    : await readAgentSnapshot(options.get("--data") as string);
  const result = createAgentTools(snapshot).call(tool as AgentToolName, input);
  process.stdout.write(JSON.stringify({ ok: true, result }) + "\n");
  if (
    ("status" in result && result.status === "blocked") ||
    ("complete" in result && !result.complete)
  )
    process.exitCode = 2;
}

void main().catch((error: unknown) => {
  const known = error instanceof AgentToolError;
  process.stdout.write(
    JSON.stringify({
      ok: false,
      error: {
        code: known ? error.code : "VALIDATION_FAILED",
        message: known ? error.message : "请求未能通过配置或任务规则校验",
      },
    }) + "\n",
  );
  process.exitCode = 1;
});
