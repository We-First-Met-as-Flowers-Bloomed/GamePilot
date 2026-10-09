import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AgentToolError } from "../../protocol/agent";
import { supportedCodexVersions } from "./adapter";

export async function findCodexExecutable(
  options: {
    localAppData?: string;
    signal?: AbortSignal;
    probe?: (path: string) => Promise<string>;
  } = {},
) {
  const cancelled = () => {
    if (options.signal?.aborted)
      throw new AgentToolError("CANCELLED", "规划已取消");
  };
  cancelled();
  const root = options.localAppData ?? process.env.LOCALAPPDATA;
  const missing = () =>
    new AgentToolError(
      "CODEX_NOT_FOUND",
      "未找到 Codex 桌面安装。请先安装并登录 Codex，再重试。",
    );
  if (!root) throw missing();
  const bin = join(root, "OpenAI", "Codex", "bin");
  const dirs = await readdir(bin, { withFileTypes: true }).catch(() => []);
  const candidates: { path: string; time: number }[] = [];
  for (const dir of dirs
    .filter((d) => d.isDirectory() && !d.isSymbolicLink())
    .slice(0, 64)) {
    const path = join(bin, dir.name, "codex.exe");
    const info = await stat(path).catch(() => undefined);
    if (info?.isFile()) candidates.push({ path, time: info.mtimeMs });
  }
  if (!candidates.length) throw missing();
  const probe =
    options.probe ??
    (async (path: string) =>
      (
        await promisify(execFile)(path, ["--version"], {
          windowsHide: true,
          timeout: 3000,
          maxBuffer: 4096,
          signal: options.signal,
        })
      ).stdout);
  for (const candidate of candidates
    .sort((a, b) => b.time - a.time)
    .slice(0, 8)) {
    cancelled();
    const version = await probe(candidate.path).catch(() => "");
    cancelled();
    if (supportedCodexVersions.includes(version.trim())) return candidate.path;
  }
  throw new AgentToolError(
    "UNSUPPORTED_CODEX",
    "已找到 Codex，但没有经过验证的版本。当前支持：" +
      supportedCodexVersions.join("、"),
  );
}
