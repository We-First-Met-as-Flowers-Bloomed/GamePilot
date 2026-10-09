import { AgentToolError } from "../protocol/agent";
import { readConfiguredSnapshot } from "./configured";
import { createAgentTools } from "./tools";

async function main() {
  const args = process.argv.slice(2);
  const options = new Map<string, string | true>();
  const invalid = () =>
    new AgentToolError(
      "CLI_USAGE",
      "使用 --data 目录 --list；或 --data 目录 --request 脱敏编号 --revision 查询版本。只读导出，不调用模型或游戏。",
    );
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (
      !["--data", "--list", "--request", "--revision"].includes(key) ||
      options.has(key)
    )
      throw invalid();
    if (key === "--list") options.set(key, true);
    else {
      if (!args[i + 1] || args[i + 1].startsWith("--")) throw invalid();
      options.set(key, args[++i]);
    }
  }
  if (
    !options.has("--data") ||
    (options.has("--list")
      ? options.size !== 2
      : options.size !== 3 ||
        !options.has("--request") ||
        !options.has("--revision"))
  )
    throw invalid();
  const first = await readConfiguredSnapshot(options.get("--data") as string, {
    history: true,
  });
  const tools = createAgentTools(first.snapshot);
  const result = options.has("--list")
    ? tools.call("get_environment")
    : tools.call("get_incident", {
        requestId: options.get("--request"),
        environmentRevision: options.get("--revision"),
      });
  const after = await readConfiguredSnapshot(options.get("--data") as string, {
    history: true,
  });
  if (after.fingerprint !== first.fingerprint)
    throw new AgentToolError("HISTORY_CHANGED", "导出期间记录变化，请重新查询");
  process.stdout.write(JSON.stringify({ ok: true, result }) + "\n");
}
void main().catch((error) => {
  process.stdout.write(
    JSON.stringify({
      ok: false,
      canExecute: false,
      error: {
        code: error instanceof AgentToolError ? error.code : "INCIDENT_FAILED",
        message:
          error instanceof AgentToolError
            ? error.message
            : "故障证据读取失败，未执行任何游戏动作",
      },
    }) + "\n",
  );
  process.exitCode = 1;
});
