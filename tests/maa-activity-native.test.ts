import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import contract from "../games/arknights/engine-contract.json";
import { syncActivityNavigation } from "../packages/runtime/maa-activity-resource";

const exe = resolve("dist/maa-bridge/GamePilot.MaaBridge.exe"),
  core = resolve("dist/resources/maa-" + contract.version);
const nativeReady = existsSync(exe) && existsSync(join(core, "MaaCore.dll"));
function invoke(requests: Record<string, unknown>[]) {
  const result = spawnSync(exe, [], {
    input: requests.map((request) => JSON.stringify(request)).join("\n") + "\n",
    encoding: "utf8",
    windowsHide: true,
    timeout: 60000,
    maxBuffer: 4 * 1024 * 1024,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return result.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line))
    .filter((value) => value.id);
}
it.skipIf(!nativeReady)(
  "loads the hash-verified tasks/activity.json overlay in real MaaCore before validating a new task, without connecting or starting",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "gp-native-activity-")),
      route = "GamePilotActivityNavigationProbe";
    const raw = JSON.stringify({
      [route]: { algorithm: "JustReturn", action: "DoNothing" },
    });
    const overlay = await syncActivityNavigation(join(root, "overlay"), {
      fetchData: async () => ({ raw, data: JSON.parse(raw) }),
    });
    expect(overlay).toBeDefined();
    const init = {
      id: 1,
      method: "init",
      coreDir: core,
      logDir: join(root, "baseline-logs"),
    };
    const validate = {
      id: 2,
      method: "validateTask",
      type: "Custom",
      params: { task_names: [route] },
    };
    const baseline = invoke([init, validate, { id: 3, method: "close" }]);
    expect(baseline[0]).toMatchObject({ ok: true });
    expect(baseline[1]).toMatchObject({ ok: false });
    const loaded = invoke([
      {
        ...init,
        logDir: join(root, "overlay-logs"),
        activityDirectory: overlay!.directory,
        activitySha256: overlay!.sha256,
      },
      validate,
      { id: 3, method: "close" },
    ]);
    expect(loaded).toHaveLength(3);
    for (const response of loaded) expect(response).toMatchObject({ ok: true });
  },
  70000,
);

it.skipIf(!nativeReady)(
  "rejects an unverified extra native overlay file before creating the engine handle",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "gp-native-activity-extra-")),
      raw = JSON.stringify({
        GamePilotActivityProbe: { algorithm: "JustReturn" },
      });
    const overlay = await syncActivityNavigation(join(root, "overlay"), {
      fetchData: async () => ({ raw, data: JSON.parse(raw) }),
    });
    expect(overlay).toBeDefined();
    await writeFile(
      join(overlay!.directory, "resource", "tasks", "unverified.json"),
      "{}",
    );
    const result = invoke([
      {
        id: 1,
        method: "init",
        coreDir: core,
        logDir: join(root, "logs"),
        activityDirectory: overlay!.directory,
        activitySha256: overlay!.sha256,
      },
    ]);
    expect(result[0]).toMatchObject({
      ok: false,
      error: expect.stringContaining("Unexpected activity resource files"),
    });
  },
  70000,
);
