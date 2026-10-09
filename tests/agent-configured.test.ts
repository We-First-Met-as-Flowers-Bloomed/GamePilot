import { afterEach, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixtureSnapshot } from "../packages/agent/fixture";
import { readConfiguredSnapshot } from "../packages/agent/configured";
import { createAgentTools } from "../packages/agent/tools";
import { PlannerSession } from "../packages/agent/planner";
import { presentAgentParameters } from "../games/agent-presentation";
import { taskRecordKey } from "../packages/protocol/task-record";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "gp-configured-"));
  dirs.push(dir);
  const raw = createFixtureSnapshot();
  raw.lanes!.lanes[0].id = "private-lane";
  raw.lanes!.lanes[0].name = "private-name";
  raw.lanes!.lanes[0].managerPath = "D:/private-path/MuMuManager.exe";
  const profile = raw.profiles!.profiles[0];
  raw.lanes!.lanes[0].arknights.profileId = "private-profile";
  raw.profiles!.activeProfileId = profile.id = "private-profile";
  profile.name = profile.accountName = "private-account";
  profile.expectedUid = "987654321";
  profile.copilotFile = "D:/private-copilot.json";
  profile.stage = "CE-6";
  await writeFile(join(dir, "device-lanes.json"), JSON.stringify(raw.lanes));
  await writeFile(join(dir, "arknights.json"), JSON.stringify(raw.profiles));
  return { dir, raw };
}
it("projects private config before any tool/model access and preserves saved tasks", async () => {
  const { dir } = await setup();
  const before = await readFile(join(dir, "arknights.json"), "utf8");
  const { snapshot } = await readConfiguredSnapshot(dir);
  const tools = createAgentTools(snapshot);
  const env = tools.call("get_environment");
  expect(env).toMatchObject({
    source: "configured",
    complete: true,
    historyAvailable: false,
  });
  expect(env.lanes[0]).toMatchObject({
    id: "lane-a",
    games: { arknights: { uidConfigured: true } },
    recordedRequestCount: null,
  });
  const session = new PlannerSession(tools, "2026-09-26T00:00:00.000Z");
  const draft = tools.call("compile_plan", {
    catalogRevision: tools.call("list_capabilities").revision,
    environmentRevision: env.revision,
    at: session.at,
    lanes: [{ laneId: "lane-a", games: [{ gameId: "arknights" }] }],
  });
  expect(draft).toMatchObject({ status: "valid", canExecute: false });
  expect(draft.lanes[0].games[0].parameters).toMatchObject({
    stage: "CE-6",
    medicine: 0,
    stone: 0,
    expiringMedicine: 0,
  });
  expect(() => tools.call("get_run", { requestId: "anything" })).toThrow(
    /未读取/,
  );
  const payload = JSON.stringify([snapshot, env, draft]);
  for (const secret of ["private-", "987654321", "111111111", "222222222"])
    expect(payload).not.toContain(secret);
  expect(
    session.finish(
      JSON.stringify({ kind: "answer", text: "未检查现场", planHash: null }),
    ).source,
  ).toBe("configured");
  expect(await readFile(join(dir, "arknights.json"), "utf8")).toBe(before);
  expect((await readdir(dir)).sort()).toEqual([
    "arknights.json",
    "device-lanes.json",
  ]);
});
it("keeps private-only configuration changes in the host fingerprint", async () => {
  const { dir, raw } = await setup();
  const a = await readConfiguredSnapshot(dir);
  raw.profiles!.profiles[0].expectedUid = "876543210";
  await writeFile(join(dir, "arknights.json"), JSON.stringify(raw.profiles));
  const b = await readConfiguredSnapshot(dir);
  expect(a.fingerprint).not.toBe(b.fingerprint);
  expect(a.configurationFingerprint).not.toBe(b.configurationFingerprint);
  expect(a.snapshot.profiles).toEqual(b.snapshot.profiles);
});
it("keeps a separate private configuration fingerprint independent of recorded history", async () => {
  const { dir, raw } = await setup();
  await mkdir(join(dir, "execution-requests"));
  await mkdir(join(dir, "task-runs"));
  const configured = await readConfiguredSnapshot(dir);
  const recorded = await readConfiguredSnapshot(dir, { history: true });
  expect(configured.configurationFingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(recorded.configurationFingerprint).toBe(
    configured.configurationFingerprint,
  );
  expect(recorded.fingerprint).not.toBe(configured.fingerprint);
  expect(JSON.stringify(recorded.snapshot)).not.toContain(
    configured.configurationFingerprint,
  );
  const task = raw.tasks[0];
  const key = createHash("sha256").update(taskRecordKey(task)).digest("hex");
  await writeFile(join(dir, "task-runs", `${key}.json`), JSON.stringify(task));
  const progressed = await readConfiguredSnapshot(dir, { history: true });
  expect(progressed.fingerprint).not.toBe(recorded.fingerprint);
  expect(progressed.configurationFingerprint).toBe(
    recorded.configurationFingerprint,
  );
});
it("discloses inherited award actions and time limits in tools and review cards", async () => {
  const { dir, raw } = await setup();
  Object.assign(raw.profiles!.profiles[0], {
    freeRecruit: true,
    eventOrundum: true,
    eventMining: true,
    specialAccess: true,
    signInEvent: false,
    maxRunMinutes: 55,
  });
  await writeFile(join(dir, "arknights.json"), JSON.stringify(raw.profiles));
  const tools = createAgentTools((await readConfiguredSnapshot(dir)).snapshot);
  const env = tools.call("get_environment");
  expect(env.lanes[0].games.arknights.saved).toMatchObject({
    freeRecruit: true,
    maxRunMinutes: 55,
  });
  const args = {
    catalogRevision: tools.call("list_capabilities").revision,
    environmentRevision: env.revision,
    at: "2026-09-26T00:00:00Z",
    lanes: [
      {
        laneId: "lane-a",
        games: [{ gameId: "arknights", skillIds: ["login", "award"] }],
      },
    ],
  };
  const game = tools.call("compile_plan", args).lanes[0].games[0];
  expect(game.parameters).toMatchObject({
    freeRecruit: true,
    eventOrundum: true,
    eventMining: true,
    specialAccess: true,
    signInEvent: false,
    maxRunMinutes: 55,
  });
  expect(game.notes.join()).toContain("免费单抽");
  expect(presentAgentParameters("arknights", game.parameters)).toContainEqual({
    label: "时长上限（分钟）",
    value: "55",
  });
  expect(
    JSON.stringify(presentAgentParameters("arknights", game.parameters)),
  ).toContain("免费单抽");
  args.lanes[0].games[0].skillIds = ["login"];
  expect(
    tools.call("compile_plan", args).lanes[0].games[0].parameters.freeRecruit,
  ).toBe(false);
});
it("ignores disabled registered extensions in a saved daily routine", async () => {
  const { dir, raw } = await setup();
  raw.lanes!.lanes[0].arknights.routine = {
    version: 1,
    steps: [
      { skillId: "login", enabled: true },
      { skillId: "award", enabled: true },
      { skillId: "copilot", enabled: false },
    ],
  };
  await writeFile(join(dir, "device-lanes.json"), JSON.stringify(raw.lanes));
  const tools = createAgentTools((await readConfiguredSnapshot(dir)).snapshot);
  const draft = tools.call("compile_plan", {
    catalogRevision: tools.call("list_capabilities").revision,
    environmentRevision: tools.call("get_environment").revision,
    at: "2026-09-26T00:00:00Z",
    lanes: [{ laneId: "lane-a", games: [{ gameId: "arknights" }] }],
  });
  expect(draft.lanes[0].games[0].plan.skillIds).toEqual(["login", "award"]);
});
it("fails closed with safe errors for missing, oversized or invalid configuration", async () => {
  const { dir } = await setup();
  for (const text of [
    "private-invalid-json",
    "x".repeat(1024 * 1024 + 1),
    JSON.stringify({ secret: "private-value" }),
  ]) {
    await writeFile(join(dir, "arknights.json"), text);
    await expect(readConfiguredSnapshot(dir)).rejects.toMatchObject({
      code: "CONFIGURATION_UNAVAILABLE",
      message: "账号配置无法完整读取，请检查设置后重试",
    });
  }
  await rm(join(dir, "arknights.json"));
  await expect(readConfiguredSnapshot(dir)).rejects.toMatchObject({
    code: "CONFIGURATION_UNAVAILABLE",
  });
});
