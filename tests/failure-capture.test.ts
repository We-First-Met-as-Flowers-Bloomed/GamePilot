import { afterEach, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { captureFailureImage } from "../packages/runtime/failure-capture";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const rel = relative(resolve(tmpdir()), root);
    if (!rel || rel.startsWith("..") || isAbsolute(rel))
      throw Error("unsafe cleanup");
    await rm(root, { recursive: true, force: true });
  }
});
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
const device = {
  name: "PRIVATE",
  adbPath: "D:/PRIVATE/adb.exe",
  address: "127.0.0.1:5555",
};
const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), "gp-failure-"));
  roots.push(root);
  return root;
};
it("captures exactly one read-only screenshot and persists its digest without paths or private data", async () => {
  const root = await setup();
  const calls: string[][] = [];
  const evidence = await captureFailureImage(
    root,
    device,
    new AbortController().signal,
    async (_file, args) => {
      calls.push(args);
      return png;
    },
  );
  expect(calls).toEqual([
    ["-s", device.address, "exec-out", "screencap", "-p"],
  ]);
  expect(evidence.status).toBe("stored");
  if (evidence.status !== "stored") throw Error("missing image");
  expect(evidence.sha256).toBe(createHash("sha256").update(png).digest("hex"));
  expect(await readFile(join(root, "failure-evidence", evidence.key))).toEqual(
    png,
  );
  expect(JSON.stringify(evidence)).not.toMatch(/PRIVATE|5555/);
});
it("refuses invalid images, exhausted storage and aborted capture without overwriting evidence", async () => {
  const root = await setup();
  const run = async () => png;
  expect(
    (
      await captureFailureImage(
        root,
        device,
        new AbortController().signal,
        async () => Buffer.from("PRIVATE"),
      )
    ).status,
  ).toBe("unavailable");
  const controller = new AbortController();
  controller.abort();
  expect(
    (await captureFailureImage(root, device, controller.signal, run)).status,
  ).toBe("unavailable");
  await mkdir(join(root, "failure-evidence"), { recursive: true });
  for (let i = 0; i < 32; i++)
    await writeFile(join(root, "failure-evidence", `${i}.png`), png);
  expect(
    (await captureFailureImage(root, device, new AbortController().signal, run))
      .status,
  ).toBe("unavailable");
  expect(await readdir(join(root, "failure-evidence"))).toHaveLength(32);
});
