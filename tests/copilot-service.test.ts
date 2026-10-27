import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotService } from "../apps/desktop/main/copilot-service";
import { cacheCopilotJob } from "../games/arknights/copilot-library";
import { validateCopilotJob } from "../games/arknights/copilot-policy";
import {
  validateCopilotStage,
  type PreparedCopilotPlan,
} from "../packages/protocol/copilot";
const dirs: string[] = [];
afterEach(() =>
  dirs
    .splice(0)
    .forEach((dir) => rmSync(dir, { recursive: true, force: true })),
);
const account = {
  profileId: "account-A",
  expectedUid: "12345678",
  clientType: "Official" as const,
  revision: "account-rev-1",
};
const raw = {
  stage_name: "stage_go_8",
  minimum_required: "v6.7.0",
  opers: [{ name: "先锋", skill: 1, requirements: { elite: 0, level: 1 } }],
  actions: [{ type: "SkillDaemon" }],
};
function harness() {
  const cacheDir = mkdtempSync(join(tmpdir(), "gp-copilot-"));
  dirs.push(cacheDir);
  const cached = cacheCopilotJob(
    cacheDir,
    {
      id: 1001,
      stageName: "stage_go_8",
      title: "fixture",
      uploader: "",
      uploadTime: "",
    },
    validateCopilotJob(raw),
  );
  let revision = "rev-1",
    clock = Date.now();
  const picked = {
    ...cached,
    summary: {
      id: 1001,
      stageName: "stage_go_8",
      title: "fixture",
      uploader: "",
      uploadTime: "",
    },
    job: validateCopilotJob(raw),
  };
  const execute = vi.fn(async (_plan: PreparedCopilotPlan) => ({
    executionId: "execution-1",
  }));
  const lookup = vi.fn(async () => picked);
  const search = vi.fn(async () => [
    {
      id: 1001,
      stageName: "stage_go_8",
      title: "fixture",
      uploader: "",
      uploadTime: "",
    },
  ]);
  const current = { ...account };
  const service = new CopilotService({
    cacheDir,
    account: () => current,
    revision: () => revision,
    resolveStage: () => ({
      id: "stage_go_8",
      code: "GO-8",
      aliases: ["stage_go_8"],
    }),
    pick: lookup,
    search,
    execute,
    now: () => clock,
  });
  return {
    service,
    cached,
    current,
    lookup,
    search,
    execute,
    setRevision: (v: string) => (revision = v),
    advance: (ms: number) => (clock += ms),
  };
}
const request = {
  profileId: "account-A",
  stage: "GO-8",
  count: 2,
  skipStory: true,
};
describe("temporary Copilot structured confirmation", () => {
  it("accepts only the exact normal stage ID, never ambiguous code, level ID or challenge aliases", () => {
    const stage = { id: "stage_go_8", code: "GO-8", aliases: ["stage_go_8"] };
    expect(validateCopilotStage(stage)).toEqual(stage);
    for (const override of [
      { aliases: ["GO-8"] },
      { aliases: ["stage_go_8", "level_go_8"] },
      { id: "stage_go_8#f", aliases: ["stage_go_8#f"] },
    ])
      expect(() => validateCopilotStage({ ...stage, ...override })).toThrow();
  });
  it("awaits asynchronous store reads while preserving concurrent confirmation idempotency", async () => {
    const h = harness();
    const service = new CopilotService({
      cacheDir: join(h.cached.file, "..", ".."),
      account: async () => ({ ...account }),
      revision: async () => "rev-1",
      resolveStage: async () => ({
        id: "stage_go_8",
        code: "GO-8",
        aliases: ["stage_go_8"],
      }),
      pick: h.lookup,
      search: h.search,
      execute: h.execute,
    });
    const p = await service.prepare(request),
      c = {
        preparedId: p.preparedId,
        planHash: p.planHash,
        revision: p.revision,
      };
    await Promise.all([service.confirm(c), service.confirm(c)]);
    expect(h.execute).toHaveBeenCalledTimes(1);
  });
  it("searches and prepares without execution; freezes account, job bytes, exact count and zero refill budget", async () => {
    const h = harness();
    const daily = JSON.stringify({ stage: "LS-6", schedule: "unchanged" });
    await h.service.search({ stage: "GO-8", limit: 3 });
    const prepared = await h.service.prepare(request);
    expect(prepared).toMatchObject({
      version: 1,
      revision: "rev-1",
      account,
      stage: { id: "stage_go_8", code: "GO-8" },
      count: 2,
      budget: { maxBattles: 2, sanityPotions: 0, originite: 0 },
      skipStory: true,
      precheck: { status: "pending-live" },
    });
    expect(prepared.jobs).toHaveLength(2);
    expect(prepared.jobs[0].sha256).toBe(h.cached.sha256);
    expect(prepared.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(h.execute).not.toHaveBeenCalled();
    expect(daily).toBe(
      JSON.stringify({ stage: "LS-6", schedule: "unchanged" }),
    );
  });
  it("confirms the precise immutable preparation once even while the first submission is pending", async () => {
    const h = harness();
    let resolve!: (x: { executionId: string }) => void;
    h.execute.mockImplementation(() => new Promise((r) => (resolve = r)));
    const p = await h.service.prepare(request);
    const c = {
      preparedId: p.preparedId,
      planHash: p.planHash,
      revision: p.revision,
    };
    const first = h.service.confirm(c),
      second = h.service.confirm(c);
    await vi.waitFor(() => expect(h.execute).toHaveBeenCalledTimes(1));
    p.account.expectedUid = "99999999";
    p.jobs[0].sha256 = "a".repeat(64);
    expect(h.execute.mock.calls[0][0].account.expectedUid).toBe(
      account.expectedUid,
    );
    resolve({ executionId: "one" });
    expect(await first).toEqual(await second);
    expect(await h.service.confirm(c)).toMatchObject({ executionId: "one" });
    expect(h.execute).toHaveBeenCalledTimes(1);
  });
  it.each(["hash", "revision", "account", "expired", "bytes"])(
    "rejects %s changes before any submission",
    async (kind) => {
      const h = harness();
      const p = await h.service.prepare(request);
      const c = {
        preparedId: p.preparedId,
        planHash: p.planHash,
        revision: p.revision,
      };
      if (kind === "hash") c.planHash = "f".repeat(64);
      if (kind === "revision") h.setRevision("rev-2");
      if (kind === "account") h.current.expectedUid = "99999999";
      if (kind === "expired") h.advance(600001);
      if (kind === "bytes") writeFileSync(h.cached.file, "corrupt");
      await expect(h.service.confirm(c)).rejects.toThrow();
      expect(h.execute).not.toHaveBeenCalled();
    },
  );
  it("rejects unknown IDs, arbitrary paths, unsupported story preference and out-of-budget counts", async () => {
    const h = harness();
    await expect(
      h.service.confirm({
        preparedId: "missing",
        planHash: "f".repeat(64),
        revision: "rev-1",
      }),
    ).rejects.toThrow();
    for (const input of [
      { ...request, count: 4 },
      { ...request, count: 0 },
      { ...request, skipStory: false },
      { ...request, filename: "anything.json" },
    ])
      await expect(h.service.prepare(input)).rejects.toThrow();
    expect(h.lookup).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
  });
  it("rejects lookup paths outside its reviewed content cache without modifying originals", async () => {
    const h = harness();
    const original = readFileSync(h.cached.file, "utf8");
    h.lookup.mockImplementation(
      async () =>
        ({
          file: join(tmpdir(), "foreign.json"),
          sha256: h.cached.sha256,
          summary: { id: 1001, title: "x" },
          job: validateCopilotJob(raw),
        }) as never,
    );
    await expect(h.service.prepare(request)).rejects.toThrow();
    expect(readFileSync(h.cached.file, "utf8")).toBe(original);
  });
  it("does not resubmit an unknown/rejected execution on repeated confirmation", async () => {
    const h = harness();
    h.execute.mockRejectedValue(new Error("submission unknown"));
    const p = await h.service.prepare(request),
      c = {
        preparedId: p.preparedId,
        planHash: p.planHash,
        revision: p.revision,
      };
    await expect(h.service.confirm(c)).rejects.toThrow("unknown");
    await expect(h.service.confirm(c)).rejects.toThrow("unknown");
    expect(h.execute).toHaveBeenCalledTimes(1);
  });
});
