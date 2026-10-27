import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  templateInventory,
  checkTemplateManifest,
  applyTemplateManifest,
  parseTemplateArgs,
} from "../scripts/template-guide.mjs";

const roots: string[] = [];
function crc(bytes: Buffer) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let i = 0; i < 8; i++)
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function png(width: number, height: number) {
  function chunk(type: string, data: Buffer) {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(data.length);
    const payload = Buffer.concat([Buffer.from(type), data]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(payload));
    return Buffer.concat([header, payload, tail]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.alloc((width * 4 + 1) * height))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gamepilot-template-guide-"));
  roots.push(root);
  await mkdir(join(root, "games/onmyoji/resources/image"), { recursive: true });
  await writeFile(
    join(root, "games/onmyoji/daily.ts"),
    'device.matchTemplate("entry.png", [10, 20, 50, 40], 0.85, signal); device.matchFeatures?.("entry.png", [0, 0, 70, 80], signal); device.matchTemplate("missing.png", [0, 0, 50, 40], 0.8, signal);',
  );
  await writeFile(
    join(root, "games/onmyoji/resources/image/entry.png"),
    png(10, 10),
  );
  await writeFile(join(root, "screen.png"), png(1920, 1080));
  await writeFile(join(root, "crop.png"), png(10, 10));
  const mapping = (name: string) => ({
    name,
    screenshot: "screen.png",
    template: "crop.png",
    crop: [10, 20, 10, 10],
    roi: [0, 0, 70, 80],
    threshold: 0.85,
  });
  const manifest = {
    schemaVersion: 1,
    coordinateSpace: [1920, 1080],
    mappings: [mapping("entry.png"), mapping("missing.png")],
  };
  return { root, manifest };
}
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
describe("local template capture guide", () => {
  it("derives required names, missing assets and actual call ROIs without inventing anchors", async () => {
    const { root } = await fixture();
    const inventory = await templateInventory(root);
    expect(inventory.map((i) => [i.name, i.present, i.uses.length])).toEqual([
      ["entry.png", true, 2],
      ["missing.png", false, 1],
    ]);
    expect(inventory[0].uses[0]).toMatchObject({
      algorithm: "TemplateMatch",
      roi: [10, 20, 50, 40],
      threshold: 0.85,
    });
    expect(inventory[0].uses[1]).toMatchObject({
      algorithm: "FeatureMatch",
      threshold: null,
    });
  });
  it("checks supplied PNG/crop/ROI/threshold while retaining pending visual/device validation", async () => {
    const { root, manifest } = await fixture();
    const report = await checkTemplateManifest({
      root,
      manifest,
      manifestDirectory: root,
    });
    expect(report.status).toBe("ready-for-review");
    expect(report.certification).toBe("pending-real-device");
    expect(report.templates[0].screenshot.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(report.templates[0].template.width).toBe(10);
    expect(report.limits.join(" ")).toContain("semantic");
  });
  it("blocks missing, duplicate, unsafe, corrupt and out-of-bounds captures", async () => {
    const { root, manifest } = await fixture();
    manifest.mappings[0].crop = [1919, 0, 10, 10];
    manifest.mappings[0].threshold = 0.2;
    manifest.mappings[0].template = "../escape.png";
    manifest.mappings.push({ ...manifest.mappings[0] });
    manifest.mappings = manifest.mappings.filter(
      (m) => m.name !== "missing.png",
    );
    const report = await checkTemplateManifest({
      root,
      manifest,
      manifestDirectory: root,
    });
    expect(report.status).toBe("blocked");
    expect(report.gaps.join(" ")).toMatch(/duplicate/i);
    expect(report.gaps.join(" ")).toContain("missing.png");
    await writeFile(join(root, "crop.png"), Buffer.alloc(30));
    const valid = await fixture();
    await writeFile(join(valid.root, "crop.png"), png(10, 10).subarray(0, 50));
    expect(
      (
        await checkTemplateManifest({
          root: valid.root,
          manifest: valid.manifest,
          manifestDirectory: valid.root,
        })
      ).status,
    ).toBe("blocked");
  });
  it("stages reviewed local copies only into a new explicit task root and refuses overwrite or links", async () => {
    const { root, manifest } = await fixture();
    const taskRoot = join(root, "capture-task");
    await applyTemplateManifest({
      root,
      manifest,
      manifestDirectory: root,
      taskRoot,
    });
    expect(await readFile(join(taskRoot, "image/missing.png"))).toEqual(
      await readFile(join(root, "crop.png")),
    );
    const staged = JSON.parse(
      await readFile(join(taskRoot, "capture-manifest.json"), "utf8"),
    );
    expect(
      (
        await checkTemplateManifest({
          root,
          manifest: staged,
          manifestDirectory: taskRoot,
        })
      ).status,
    ).toBe("ready-for-review");
    await expect(
      applyTemplateManifest({
        root,
        manifest,
        manifestDirectory: root,
        taskRoot,
      }),
    ).rejects.toThrow(/exist/i);
    expect(
      await readFile(join(root, "games/onmyoji/resources/image/entry.png")),
    ).toEqual(await readFile(join(root, "crop.png")));
    const target = join(root, "linked");
    await symlink(root, target, "junction");
    await expect(
      applyTemplateManifest({
        root,
        manifest,
        manifestDirectory: root,
        taskRoot: join(target, "output"),
      }),
    ).rejects.toThrow(/link/i);
  });
  it("requires explicit apply task root and rejects conflicting/unknown flags", () => {
    expect(parseTemplateArgs(["--guide"])).toMatchObject({ mode: "guide" });
    expect(() =>
      parseTemplateArgs(["--apply", "--manifest", "capture.json"]),
    ).toThrow(/task-root/);
    expect(() => parseTemplateArgs(["--check", "--guide"])).toThrow();
    expect(() => parseTemplateArgs(["--delete"])).toThrow();
  });
});
