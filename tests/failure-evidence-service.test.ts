import { afterEach, expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  rmdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { FailureEvidenceService } from "../apps/desktop/main/failure-evidence-service";
import { ExecutionCoordinator } from "../apps/desktop/main/execution-coordinator";
import { RunLedger } from "../apps/desktop/main/run-ledger";
import type { RunEvent } from "../packages/protocol";
const roots: string[] = [];
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
const key = "0b90d4cd-3271-44f7-955d-4e532b968ffb.png";
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const rel = relative(tmpdir(), root);
    if (!rel || rel.startsWith("..") || isAbsolute(rel))
      throw Error("unsafe cleanup");
    await rm(root, { recursive: true, force: true });
  }
});
async function setup(laneId = "lane-a") {
  const root = await mkdtemp(join(tmpdir(), "gp-evidence-"));
  roots.push(root);
  const executions = new ExecutionCoordinator(join(root, "requests"));
  await executions.load();
  const lease = await executions.begin({
    id: "request",
    source: "daily",
    laneId,
    batchId: "batch",
    resources: ["device"],
    snapshot: {
      lane: { id: laneId, instance: 0, arknights: { profileId: "default" } },
      profile: { id: "default" },
      arknightsPlan: { gameId: "arknights", mode: "live", skillIds: ["login"] },
    },
  });
  const ledger = new RunLedger(join(root, "task-runs"));
  await ledger.load();
  const at = executions.get("request").startedAt;
  const event: RunEvent = {
    executionId: "request",
    runId: "run",
    laneId,
    instance: 0,
    profileId: "default",
    batchId: "batch",
    gameId: "arknights",
    type: "status",
    status: "queued",
    at,
    message: "",
    plan: { gameId: "arknights", mode: "live", skillIds: ["login"] },
  };
  await ledger.append(event);
  await ledger.append({
    ...event,
    type: "step",
    skillId: "login",
    stepStatus: "running",
  });
  await ledger.append({
    ...event,
    type: "step",
    skillId: "login",
    stepStatus: "failed",
    fault: {
      version: 1,
      code: "skill-exception",
      source: "runner",
      runId: "run",
      skillId: "login",
      observedAt: at,
      capture: {
        status: "stored",
        key,
        sha256: createHash("sha256").update(png).digest("hex"),
        bytes: png.length,
        width: 1,
        height: 1,
        capturedAt: at,
      },
    },
  });
  await ledger.append({ ...event, status: "failed" });
  await lease.finish("unknown", "failed");
  const folder = join(root, "lanes", laneId, "failure-evidence");
  await mkdir(folder, { recursive: true });
  const file = join(folder, key);
  await writeFile(file, png);
  return {
    root,
    folder,
    file,
    executions,
    ledger,
    service: new FailureEvidenceService(root, executions, ledger),
  };
}
it("reads verified local evidence and deletes only the requested image while preserving both ledgers", async () => {
  const { service, ledger, executions } = await setup();
  const before = JSON.stringify([ledger.snapshot(), executions.snapshot()]);
  const items = await service.list("request");
  expect(items).toHaveLength(1);
  expect(JSON.stringify(items)).not.toMatch(/sha256|\.png|failure-evidence/);
  expect(await service.read({ requestId: "request", runId: "run" })).toEqual({
    status: "available",
    image: `data:image/png;base64,${png.toString("base64")}`,
  });
  await service.remove({ requestId: "request", runId: "run" });
  expect(await service.read({ requestId: "request", runId: "run" })).toEqual({
    status: "missing",
  });
  await service.remove({ requestId: "request", runId: "run" });
  expect(JSON.stringify([ledger.snapshot(), executions.snapshot()])).toBe(
    before,
  );
});
it("rejects mismatched requests, extra path arguments, invalid data, and active cleanup", async () => {
  const { service, file, executions } = await setup();
  await expect(
    service.read({ requestId: "other", runId: "run" }),
  ).rejects.toThrow();
  await expect(
    service.read({ requestId: "request", runId: "other" }),
  ).rejects.toThrow();
  await expect(
    service.read({ requestId: "request", runId: "run", path: file }),
  ).rejects.toThrow();
  const lease = await executions.begin({
    id: "active",
    source: "single",
    resources: ["device"],
    snapshot: {},
  });
  await expect(
    service.remove({ requestId: "request", runId: "run" }),
  ).rejects.toThrow();
  await lease.finish("cancelled", "test");
  await writeFile(file, Buffer.alloc(png.length));
  await expect(
    service.read({ requestId: "request", runId: "run" }),
  ).rejects.toThrow();
  await expect(
    service.remove({ requestId: "request", runId: "run" }),
  ).rejects.toThrow();
  expect(await readFile(file)).toEqual(Buffer.alloc(png.length));
});
it("refuses directory junctions and never reads or deletes their targets", async () => {
  const { service, folder, root, file } = await setup();
  const elsewhere = join(root, "elsewhere");
  await mkdir(elsewhere);
  await writeFile(join(elsewhere, key), png);
  await rm(file);
  await rmdir(folder);
  await symlink(elsewhere, folder, "junction");
  await expect(
    service.read({ requestId: "request", runId: "run" }),
  ).rejects.toThrow();
  await expect(
    service.remove({ requestId: "request", runId: "run" }),
  ).rejects.toThrow();
  expect(await readFile(join(elsewhere, key))).toEqual(png);
});
it("rejects conflicts with the frozen instance, profile or plan even when request IDs match", async () => {
  const { ledger, service } = await setup();
  const original = ledger.forExecution("request");
  for (const edit of [
    { instance: 9 },
    { profileId: "other" },
    { plan: { ...original[0].plan, mode: "rehearsal" as const } },
    { laneId: "lane-b" },
    { batchId: "other" },
  ]) {
    const spy = vi
      .spyOn(ledger, "forExecution")
      .mockReturnValue([{ ...original[0], ...edit }]);
    expect(await service.list("request")).toEqual([]);
    await expect(
      service.read({ requestId: "request", runId: "run" }),
    ).rejects.toThrow();
    await expect(
      service.remove({ requestId: "request", runId: "run" }),
    ).rejects.toThrow();
    spy.mockRestore();
  }
});
