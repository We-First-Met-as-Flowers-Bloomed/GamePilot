import { expect, it } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  sourceState,
  writeBuildProvenance,
  validateBuild,
} from "../scripts/build-provenance.mjs";
it("a commit during building cannot label earlier outputs as the new clean source", async () => {
  const root = await mkdtemp(join(tmpdir(), "gp-build-proof-"));
  const git = (...args: string[]) => {
    const r = spawnSync(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        ...args,
      ],
      { cwd: root, windowsHide: true },
    );
    expect(r.status).toBe(0);
  };
  try {
    await writeFile(join(root, ".gitignore"), "dist/\n");
    await writeFile(join(root, "package.json"), '{"version":"1.0.0"}');
    await writeFile(join(root, "source.ts"), "old");
    git("init");
    git("add", ".");
    git("commit", "-m", "initial");
    const before = sourceState(root);
    await writeFile(join(root, "source.ts"), "new");
    git("add", ".");
    git("commit", "-m", "changed");
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "dist/app.js"), "old-output");
    await writeBuildProvenance(root, before);
    await expect(
      validateBuild(join(root, "dist"), {
        appVersion: "1.0.0",
        sourceCommit: sourceState(root).commit,
        sourceTree: sourceState(root).tree,
      }),
    ).rejects.toThrow(/source|clean/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("a restored dirty input remains unsuitable for release and changed built bytes are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "gp-build-proof-"));
  const git = (...args: string[]) => {
    const r = spawnSync(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        ...args,
      ],
      { cwd: root, windowsHide: true },
    );
    expect(r.status).toBe(0);
  };
  try {
    await writeFile(join(root, ".gitignore"), "dist/\n");
    await writeFile(join(root, "package.json"), '{"version":"1.0.0"}');
    await writeFile(join(root, "source.ts"), "old");
    git("init");
    git("add", ".");
    git("commit", "-m", "initial");
    await writeFile(join(root, "source.ts"), "dirty");
    const dirty = sourceState(root);
    git("restore", "source.ts");
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "dist/app.js"), "output");
    await writeBuildProvenance(root, dirty);
    const clean = sourceState(root),
      expected = {
        appVersion: "1.0.0",
        sourceCommit: clean.commit,
        sourceTree: clean.tree,
      };
    await expect(validateBuild(join(root, "dist"), expected)).rejects.toThrow(
      /source|clean/i,
    );
    await writeBuildProvenance(root, clean);
    await expect(
      validateBuild(join(root, "dist"), expected),
    ).resolves.toBeDefined();
    await writeFile(join(root, "dist/app.js"), "changed");
    await expect(validateBuild(join(root, "dist"), expected)).rejects.toThrow(
      /bytes|hash|files/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
