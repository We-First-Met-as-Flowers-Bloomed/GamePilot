import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { AgentToolError, agentToolNames } from "../../protocol/agent";
import { PlannerSession, plannerInstructions } from "../planner";
import { agentToolSpecs, plannerOutputSchema } from "../tool-specs";
import type { createAgentTools } from "../tools";
import { StdioRpc, type PlannerRpc } from "./rpc";
import type {
  PlannerProgress,
  PlannerStreamEvent,
} from "../../protocol/agent-planner";
import { runCodexResponseProtocol } from "./protocol";
import type { AgentToolName } from "../../protocol/agent";

export const supportedCodexVersion = "codex-cli 0.155.0-alpha.16.4";
export const supportedCodexVersions = [
  supportedCodexVersion,
  "codex-cli 0.158.0-alpha.2.1",
];
export function assertCodexVersion(version: string) {
  if (!supportedCodexVersions.includes(version.trim()))
    throw new AgentToolError(
      "UNSUPPORTED_CODEX",
      "Codex 版本未验证，请使用已核对的适配版本",
    );
}
export function plannerConfig(
  serverNames: string[] = [],
): Record<string, unknown> {
  if (serverNames.some((name) => !/^[A-Za-z0-9_-]{1,160}$/.test(name)))
    throw new AgentToolError(
      "UNSUPPORTED_MCP_NAME",
      "MCP 名称不能通过当前版本安全覆盖，请使用独立 Codex 配置",
    );
  const off = [
    "shell_tool",
    "unified_exec",
    "apply_patch_freeform",
    "apps",
    "plugins",
    "remote_plugin",
    "connectors",
    "hooks",
    "codex_hooks",
    "plugin_hooks",
    "browser_use",
    "browser_use_external",
    "computer_use",
    "image_generation",
    "imagegenext",
    "view_image",
    "js_repl",
    "js_repl_tools_only",
    "multi_agent",
    "multi_agent_v2",
    "collab",
    "memories",
    "memory_tool",
    "skill_search",
    "skill_mcp_dependency_install",
    "tool_suggest",
    "request_permissions_tool",
    "request_permissions",
    "code_mode",
    "code_mode_only",
    "sleep_tool",
    "goals",
    "web_search",
    "web_search_request",
    "standalone_web_search",
    "send_message_to_user_async",
    "send_async_message",
    "default_mode_request_user_input",
    "external_agent_memory_import",
  ];
  return {
    ...Object.fromEntries(
      serverNames.map((name) => [`mcp_servers.${name}.enabled`, false]),
    ),
    ...Object.fromEntries(off.map((name) => [`features.${name}`, false])),
    "features.skip_host_skill_discovery": true,
    web_search: "disabled",
    project_doc_max_bytes: 0,
    notify: [],
    "history.persistence": "none",
    "analytics.enabled": false,
    include_apps_instructions: false,
    check_for_update_on_startup: false,
    model_reasoning_effort: "low",
  };
}
type Tools = ReturnType<typeof createAgentTools>;
type StartOptions = {
  prompt: string;
  cwd: string;
  model?: string;
  onProgress?: (progress: PlannerProgress) => void;
  onEvent?: (event: PlannerStreamEvent) => void;
  signal?: AbortSignal;
};

export function verifyPlannerConfiguration(
  effective: Record<string, unknown>,
  expected: Record<string, unknown>,
) {
  for (const [key, value] of Object.entries(expected)) {
    let actual: unknown = effective;
    for (const part of key.split("."))
      actual =
        actual && typeof actual === "object"
          ? (actual as Record<string, unknown>)[part]
          : undefined;
    if (JSON.stringify(actual) !== JSON.stringify(value))
      throw new AgentToolError(
        "ISOLATION_FAILED",
        "Codex 工具限制未生效，规划已停止",
      );
  }
}

export async function runPlannerProtocol(
  rpc: PlannerRpc,
  session: PlannerSession,
  tools: Tools,
  options: StartOptions,
) {
  const response = await runCodexResponseProtocol(rpc, {
    ...options,
    instructions: plannerInstructions(session.at, session.source),
    outputSchema: plannerOutputSchema,
    dynamicTools: agentToolSpecs(tools.call("list_capabilities")),
    onTool: (callId, tool, args) => {
      if (!agentToolNames.includes(tool as AgentToolName))
        throw new AgentToolError("TOOL_FORBIDDEN", "拒绝未注册工具");
      options.onEvent?.({
        kind: "tool-requested",
        callId,
        tool: tool as AgentToolName,
      });
      if (options.signal?.aborted)
        throw new AgentToolError("CANCELLED", "模型请求已取消，未执行游戏任务");
      const result = session.call(callId, tool, args, options.onEvent);
      options.onProgress?.({ phase: "tool", tool: tool as AgentToolName });
      return result;
    },
    finish: (text) => session.finish(text),
  });
  return {
    ...response.result,
    model: response.model,
    codexVersion: supportedCodexVersion,
  };
}

export interface IsolatedCodexOptions {
  executable: string;
  model?: string;
  signal?: AbortSignal;
  onProgress?: (progress: PlannerProgress) => void;
  onEvent?: (event: PlannerStreamEvent) => void;
}

export async function withIsolatedCodexRpc<T>(
  options: IsolatedCodexOptions,
  run: (
    rpc: PlannerRpc,
    cwd: string,
    version: string,
    onEvent: (event: PlannerStreamEvent) => void,
  ) => Promise<T>,
): Promise<T> {
  if (!isAbsolute(options.executable))
    throw new AgentToolError(
      "INVALID_CODEX_PATH",
      "请指定 Codex 可执行文件的绝对路径",
    );
  let rpc: StdioRpc | undefined;
  let cwd: string | undefined;
  let stopped: AgentToolError | undefined;
  let errorPublished = false;
  const controller = new AbortController();
  const onEvent = (event: PlannerStreamEvent) => {
    if (event.kind === "error") errorPublished = true;
    options.onEvent?.(event);
  };
  const stop = (error: AgentToolError) => {
    stopped ??= error;
    controller.abort();
    rpc?.stop(stopped);
  };
  const check = () => {
    if (stopped) throw stopped;
  };
  const cancel = () =>
    stop(new AgentToolError("CANCELLED", "模型请求已取消，未执行游戏任务"));
  const timeout = setTimeout(
    () =>
      stop(new AgentToolError("TIMEOUT", "模型请求超过180秒，未执行游戏任务")),
    180000,
  );
  options.signal?.addEventListener("abort", cancel, { once: true });
  const config = plannerConfig();
  const connect = async () => {
    check();
    options.onProgress?.({ phase: "connecting" });
    const args = [
      "app-server",
      "--listen",
      "stdio://",
      ...Object.entries(config).flatMap(([key, value]) => [
        "-c",
        `${key}=${JSON.stringify(value)}`,
      ]),
    ];
    rpc = new StdioRpc(options.executable, args, cwd!);
    await rpc.request("initialize", {
      clientInfo: { name: "gamepilot_planner", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    check();
    rpc.notify("initialized");
    const result = await rpc.request<{
      config: Record<string, unknown> & {
        mcp_servers?: Record<string, { enabled?: boolean }>;
      };
    }>("config/read", { includeLayers: false, cwd });
    check();
    return result.config;
  };
  try {
    if (options.signal?.aborted) cancel();
    check();
    let version: string;
    try {
      version = (
        await promisify(execFile)(options.executable, ["--version"], {
          windowsHide: true,
          timeout: 10000,
          maxBuffer: 4096,
          signal: controller.signal,
        })
      ).stdout;
    } catch {
      check();
      throw new AgentToolError("CODEX_START_FAILED", "无法读取 Codex 版本");
    }
    check();
    assertCodexVersion(version);
    cwd = await mkdtemp(join(tmpdir(), "gamepilot-planner-"));
    check();
    const initial = await connect();
    Object.assign(
      config,
      plannerConfig(Object.keys(initial.mcp_servers ?? {})),
    );
    await rpc!.close();
    const isolated = await connect();
    verifyPlannerConfiguration(isolated, config);
    if (
      Object.values(isolated.mcp_servers ?? {}).some(
        (server) => server.enabled !== false,
      )
    )
      throw new AgentToolError("ISOLATION_FAILED", "无法禁用外部 MCP 连接");
    options.onProgress?.({ phase: "checking" });
    const account = await rpc!.request<{ account: unknown }>("account/read", {
      refreshToken: false,
    });
    check();
    if (!account.account)
      throw new AgentToolError(
        "AUTH_REQUIRED",
        "请先在本机 Codex 登录，再运行规划原型",
      );
    return await run(rpc!, cwd, version.trim(), onEvent);
  } catch (failure) {
    const error =
      stopped ??
      (failure instanceof AgentToolError
        ? failure
        : new AgentToolError("MODEL_FAILED", "模型调用未完成，未执行游戏任务"));
    if (!errorPublished)
      try {
        onEvent({
          kind: "attempt",
          attempt: 1,
          status: error.code === "CANCELLED" ? "cancelled" : "failed",
          code: error.code,
        });
        onEvent({ kind: "error", code: error.code, message: error.message });
      } catch {}
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", cancel);
    await rpc?.close();
    if (cwd) {
      const rel = relative(resolve(tmpdir()), resolve(cwd));
      if (rel && !rel.startsWith("..") && !isAbsolute(rel))
        await rm(cwd, { recursive: true, force: true });
    }
  }
}

export async function planWithCodex(
  tools: Tools,
  options: IsolatedCodexOptions & { prompt: string; at: string },
) {
  if (
    typeof options.prompt !== "string" ||
    !options.prompt.trim() ||
    options.prompt.length > 12000
  )
    throw new AgentToolError("INVALID_PROMPT", "需求文本须为1至12000字符");
  const session = new PlannerSession(tools, options.at);
  const started = Date.now();
  return withIsolatedCodexRpc(options, async (rpc, cwd, version, onEvent) => {
    const result = await runPlannerProtocol(rpc, session, tools, {
      prompt: options.prompt,
      cwd,
      model: options.model,
      onProgress: options.onProgress,
      onEvent,
      signal: options.signal,
    });
    return {
      ...result,
      codexVersion: version,
      elapsedMs: Date.now() - started,
      transport: "codex" as const,
    };
  });
}
