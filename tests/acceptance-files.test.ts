import { it, expect } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  writeFile,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { readEvidence } from "../packages/acceptance/files";

it("reads active receipts without recovering, rewriting or inventing missing step records", async () => {
  const root = await mkdtemp(join(tmpdir(), "gp-audit-"));
  try {
    const directory = join(root, "execution-requests");
    await mkdir(directory);
    const id = "active:lane-a";
    const file = join(
      directory,
      createHash("sha256").update(id).digest("hex") + ".json",
    );
    const raw = JSON.stringify({
      version: 1,
      id,
      source: "daily",
      status: "running",
      startedAt: new Date().toISOString(),
      snapshot: {},
    });
    await writeFile(file, raw);
    const read = await readEvidence(root);
    expect(read.requests[0].status).toBe("running");
    expect(read.tasks).toEqual([]);
    expect(read.errors).toEqual([]);
    expect(await readFile(file, "utf8")).toBe(raw);
    expect(await readdir(root)).toEqual(["execution-requests"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("reports malformed or wrongly identified files instead of silently accepting a clean run", async () => {
  const root = await mkdtemp(join(tmpdir(), "gp-audit-"));
  try {
    await mkdir(join(root, "task-runs"));
    await mkdir(join(root, "execution-requests"));
    await writeFile(join(root, "task-runs", "broken.json"), "{");
    await writeFile(
      join(root, "execution-requests", "wrong.json"),
      JSON.stringify({
        version: 1,
        id: "valid",
        source: "daily",
        status: "succeeded",
        startedAt: new Date().toISOString(),
        snapshot: {},
      }),
    );
    const read = await readEvidence(root);
    expect(read.errors).toHaveLength(2);
    expect(read.requests).toEqual([]);
    expect(read.tasks).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
