import { AgentToolError, agentObject } from "./agent";

export type ModelProvider = "codex" | "compatible";
export interface ModelProviderInput {
  provider: ModelProvider;
  baseUrl: string;
  model: string;
  revision: string;
  apiKey?: string;
  clearApiKey?: boolean;
}
export interface ModelProviderView {
  provider: ModelProvider;
  baseUrl: string;
  model: string;
  revision: string;
  hasApiKey: boolean;
  encryptionAvailable: boolean;
}
export interface ModelConnectionTest {
  model: string;
  elapsedMs: number;
  checkedAt: string;
}
export function normalizeModelUrl(input: unknown): string {
  const fail = () =>
    new AgentToolError(
      "INVALID_MODEL_URL",
      "请输入 HTTPS API 地址，不得包含账号、密码、查询参数或片段",
    );
  if (typeof input !== "string" || input.length > 2048 || !input.trim())
    throw fail();
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw fail();
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    /[?#]/.test(input)
  )
    throw fail();
  if (/\/(?:chat\/completions|responses)\/?$/i.test(url.pathname))
    throw new AgentToolError(
      "INVALID_MODEL_URL",
      "请填写 API 基础地址，不包含 chat/completions 或 responses",
    );
  return url.href.replace(/\/+$/, "");
}
export function validateModelProviderInput(input: unknown): ModelProviderInput {
  const value = agentObject(input, [
    "provider",
    "baseUrl",
    "model",
    "revision",
    "apiKey",
    "clearApiKey",
    "hasApiKey",
    "encryptionAvailable",
  ]);
  if (value.provider !== "codex" && value.provider !== "compatible")
    throw new AgentToolError("INVALID_PROVIDER", "不支持的模型连接方式");
  if (
    typeof value.model !== "string" ||
    !/^[\w./:\-]{1,160}$/.test(value.model)
  )
    throw new AgentToolError("INVALID_MODEL", "请输入有效的模型 ID");
  if (
    typeof value.revision !== "string" ||
    !/^[\w-]{1,80}$/.test(value.revision)
  )
    throw new AgentToolError("INVALID_REVISION", "请重新读取模型配置");
  if (
    value.apiKey !== undefined &&
    (typeof value.apiKey !== "string" ||
      !/^[\x21-\x7e]{1,4096}$/.test(value.apiKey))
  )
    throw new AgentToolError("INVALID_API_KEY", "密钥不能为空或包含空白字符");
  if (value.clearApiKey !== undefined && typeof value.clearApiKey !== "boolean")
    throw new AgentToolError("INVALID_API_KEY", "清除密钥参数无效");
  if (value.clearApiKey && value.apiKey !== undefined)
    throw new AgentToolError("INVALID_API_KEY", "不能同时替换和清除密钥");
  return {
    provider: value.provider,
    baseUrl: normalizeModelUrl(value.baseUrl),
    model: value.model,
    revision: value.revision,
    ...(value.apiKey !== undefined ? { apiKey: value.apiKey as string } : {}),
    ...(value.clearApiKey !== undefined
      ? { clearApiKey: value.clearApiKey as boolean }
      : {}),
  };
}
