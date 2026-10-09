import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, isAbsolute } from "node:path";
import { findCodexExecutable } from "../packages/agent/codex/discovery";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const rel = relative(resolve(tmpdir()), resolve(root));
    if (rel && !rel.startsWith("..") && !isAbsolute(rel))
      await rm(root, { recursive: true, force: true });
  }
});
it("finds only the supported version within the desktop installation", async () => {
  const root = await mkdtemp(join(tmpdir(), "gp-codex-find-"));
  roots.push(root);
  for (const version of ["old", "tested"]) {
    const dir = join(root, "OpenAI", "Codex", "bin", version);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "codex.exe"), "fixture");
  }
  const result = await findCodexExecutable({
    localAppData: root,
    probe: async (path) =>
      path.includes("tested")
        ? "codex-cli 0.155.0-alpha.16.4"
        : "codex-cli 0.1.0",
  });
  expect(result).toBe(
    join(root, "OpenAI", "Codex", "bin", "tested", "codex.exe"),
  );
});
it("distinguishes missing installation, unsupported version, and cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "gp-codex-find-"));
  roots.push(root);
  await expect(
    findCodexExecutable({ localAppData: root }),
  ).rejects.toMatchObject({ code: "CODEX_NOT_FOUND" });
  const dir = join(root, "OpenAI", "Codex", "bin", "new");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "codex.exe"), "fixture");
  expect(
    await findCodexExecutable({
      localAppData: root,
      probe: async () => "codex-cli 0.158.0-alpha.2.1",
    }),
  ).toBe(join(dir, "codex.exe"));
  await expect(
    findCodexExecutable({
      localAppData: root,
      probe: async () => "codex-cli 1.0.0",
    }),
  ).rejects.toMatchObject({ code: "UNSUPPORTED_CODEX" });
  const controller = new AbortController();
  controller.abort();
  await expect(
    findCodexExecutable({ localAppData: root, signal: controller.signal }),
  ).rejects.toMatchObject({ code: "CANCELLED" });
});
