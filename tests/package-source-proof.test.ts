import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
it("portable verify rejects modified copied output even when its outer file manifest matches", async () => {
  const root = await mkdtemp(join(tmpdir(), "gp-package-source-"));
  try {
    await mkdir(join(root, "resources/app/dist"), { recursive: true });
    await mkdir(join(root, "sources"));
    const source = {
      commit: "a".repeat(40),
      tree: "b".repeat(40),
      archive: "sources/GamePilot-0.16.0.tar",
      sha256: hash("source"),
    };
    const entries = {
      "resources/app/package.json": JSON.stringify({
        version: "0.16.0",
        source,
      }),
      "resources/app/dist/gamepilot-build.json": JSON.stringify({
        version: 1,
        clean: true,
        appVersion: "0.16.0",
        sourceCommit: source.commit,
        sourceTree: source.tree,
        files: { "app.js": hash("original") },
      }),
      "resources/app/dist/app.js": "changed-after-copy",
      "sources/GamePilot-0.16.0.tar": "source",
    };
    for (const [path, value] of Object.entries(entries))
      await writeFile(join(root, path), value);
    const files = Object.fromEntries(
      Object.entries(entries).map(([path, value]) => [path, hash(value)]),
    );
    await writeFile(
      join(root, "package-manifest.json"),
      JSON.stringify({ version: "0.16.0", source, files }),
    );
    const run = () =>
      spawnSync(
        process.execPath,
        [resolve("scripts/package-portable.mjs"), "--verify", root],
        { encoding: "utf8", windowsHide: true },
      );
    const changed = run();
    expect(changed.status).not.toBe(0);
    expect(changed.stderr).toContain("Built file bytes");
    await writeFile(
      join(root, "package-manifest.json"),
      JSON.stringify({ version: "0.16.0", files }),
    );
    const missing = run();
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("Source metadata");
    entries["resources/app/package.json"] = JSON.stringify({
      version: "0.16.0",
    });
    await writeFile(
      join(root, "resources/app/package.json"),
      entries["resources/app/package.json"],
    );
    files["resources/app/package.json"] = hash(
      entries["resources/app/package.json"],
    );
    await writeFile(
      join(root, "package-manifest.json"),
      JSON.stringify({ version: "0.16.0", files }),
    );
    const stripped = run();
    expect(stripped.status).not.toBe(0);
    expect(stripped.stderr).toContain("Source metadata");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
