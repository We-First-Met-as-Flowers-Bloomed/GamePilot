import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
// Standalone setup has no dependence on GamePilot's shared node_modules.
import { assertIsolatedRuntimeTarget } from "../scripts/setup-dsh-runtime.mjs";

describe("DSH isolated setup safety", () => {
  it("refuses root node_modules and paths outside the named workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "gamepilot-dsh-setup-"));
    try {
      await expect(
        assertIsolatedRuntimeTarget(join(root, "node_modules"), root),
      ).rejects.toThrow();
      await expect(
        assertIsolatedRuntimeTarget(join(root, "..", "outside"), root),
      ).rejects.toThrow();
      await expect(
        assertIsolatedRuntimeTarget(
          join(root, "integrations/deepseek-harness/runtime"),
          root,
        ),
      ).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a runtime node_modules junction before npm ci can remove it", async () => {
    const root = await mkdtemp(join(tmpdir(), "gamepilot-dsh-setup-"));
    const directory = join(root, "integrations/deepseek-harness/runtime");
    try {
      await mkdir(directory, { recursive: true });
      await mkdir(join(root, "shared"));
      await symlink(
        join(root, "shared"),
        join(directory, "node_modules"),
        process.platform === "win32" ? "junction" : "dir",
      );
      await expect(
        assertIsolatedRuntimeTarget(directory, root),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
