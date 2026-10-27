import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { auditDistribution } from "../scripts/distribution-audit.mjs";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const hash = (bytes: string) =>
  createHash("sha256").update(bytes).digest("hex");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gp-distribution-"));
  roots.push(root);
  await mkdir(join(root, "licenses"));
  await mkdir(join(root, "sources"));
  await writeFile(join(root, "engine.dll"), "binary");
  await writeFile(join(root, "licenses", "engine.txt"), "license");
  await writeFile(join(root, "sources", "engine.zip"), "source");
  const manifest = {
    version: 1,
    components: [
      {
        id: "engine",
        version: "1.0.0",
        license: "LGPL-3.0-only",
        files: [{ path: "engine.dll", sha256: hash("binary") }],
        notices: [{ path: "licenses/engine.txt", sha256: hash("license") }],
        source: {
          path: "sources/engine.zip",
          sha256: hash("source"),
          upstream: "https://example.org/engine/source",
          buildInstructions:
            "Pinned source and dependency build scripts contained in archive",
        },
      },
    ],
  };
  return { root, manifest };
}
it("does not certify a private binary inventory without a reviewed notice/source manifest", async () => {
  const { root } = await fixture();
  const report = await auditDistribution(root);
  expect(report.status).toBe("blocked");
  expect(report.binaries).toHaveLength(1);
  expect(report.gaps.join(" ")).toContain("engine.dll");
});
it("verifies component bytes, notices and corresponding source locally", async () => {
  const { root, manifest } = await fixture();
  expect((await auditDistribution(root, manifest)).status).toBe(
    "ready-for-review",
  );
  await writeFile(join(root, "engine.dll"), "changed");
  expect((await auditDistribution(root, manifest)).status).toBe("blocked");
});
it("detects unlisted binaries, incomplete LGPL source and unsafe manifest paths", async () => {
  const { root, manifest } = await fixture();
  await writeFile(join(root, "other.node"), "addon");
  expect((await auditDistribution(root, manifest)).gaps.join(" ")).toContain(
    "other.node",
  );
  delete (manifest.components[0] as { source?: unknown }).source;
  expect((await auditDistribution(root, manifest)).gaps.join(" ")).toContain(
    "source",
  );
  manifest.components[0].notices[0].path = "../outside";
  expect((await auditDistribution(root, manifest)).gaps.join(" ")).toContain(
    "unsafe",
  );
});
