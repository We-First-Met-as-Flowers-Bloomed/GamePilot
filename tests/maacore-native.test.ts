import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { taskFor, defaultArknightsConfig } from "../games/arknights/config";
const exe = resolve("dist/maa-bridge/GamePilot.MaaBridge.exe");
const core = resolve("dist/resources/maa-v6.17.5");
it.skipIf(!existsSync(exe) || !existsSync(resolve(core, "MaaCore.dll")))(
  "accepts all six daily task mappings without connecting or starting a game",
  () => {
    const skills = [
      "login",
      "recruit",
      "fight",
      "infrastructure",
      "friends",
      "award",
    ];
    const requests = [
      {
        id: 1,
        method: "init",
        coreDir: core,
        logDir: resolve("artifacts/capability-native-daily-test"),
      },
      ...skills.map((skill, index) => ({
        id: index + 2,
        method: "validateTask",
        ...taskFor(skill, {
          ...defaultArknightsConfig,
          stage: "LS-6",
          mail: true,
          creditShopping: true,
        }),
      })),
      { id: 8, method: "close" },
    ];
    const result = spawnSync(exe, [], {
      input:
        requests.map((request) => JSON.stringify(request)).join("\n") + "\n",
      encoding: "utf8",
      windowsHide: true,
      timeout: 60_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const responses = result.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line))
      .filter((value) => value.id);
    expect(responses).toHaveLength(8);
    for (const response of responses)
      expect(response).toMatchObject({ ok: true });
  },
  70_000,
);
it.skipIf(!existsSync(exe) || !existsSync(resolve(core, "MaaCore.dll")))(
  "rejects unsupported Award parameters before native validation or execution",
  () => {
    const requests = [
      {
        id: 1,
        method: "init",
        coreDir: core,
        logDir: resolve("artifacts/capability-native-test"),
      },
      {
        id: 2,
        method: "validateTask",
        type: "Award",
        params: { signinevent: true },
      },
      {
        id: 3,
        method: "runTask",
        type: "Award",
        params: { signinevent: true },
      },
      {
        id: 4,
        method: "validateTask",
        type: "Award",
        params: { signinevent: false },
      },
      {
        id: 5,
        method: "validateTask",
        type: "Award",
        params: { invented: true },
      },
      {
        id: 6,
        method: "validateTask",
        type: "Award",
        params: { mail: "true" },
      },
      {
        id: 7,
        method: "validateTask",
        type: "Award",
        params: {
          award: true,
          mail: true,
          recruit: false,
          orundum: false,
          mining: false,
          specialaccess: false,
        },
      },
      { id: 8, method: "close" },
    ];
    const result = spawnSync(exe, [], {
      input:
        requests.map((request) => JSON.stringify(request)).join("\n") + "\n",
      encoding: "utf8",
      windowsHide: true,
      timeout: 60_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const responses = result.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    const response = (id: number) => responses.find((value) => value.id === id);
    expect(response(1)).toMatchObject({ ok: true });
    for (const id of [2, 3, 4]) {
      expect(response(id)).toMatchObject({ ok: false });
      expect(response(id).error).toMatch(/signinevent.*v6\.17\.5/);
    }
    expect(response(5)).toMatchObject({ ok: false });
    expect(response(5).error).toContain("invented");
    expect(response(6)).toMatchObject({ ok: false });
    expect(response(6).error).toContain("boolean");
    expect(response(7)).toMatchObject({ ok: true });
    expect(response(8)).toMatchObject({ ok: true });
  },
  70_000,
);
it.skipIf(!existsSync(exe))(
  "reads UTF-8 JSON paths without corrupting Chinese characters",
  () => {
    const missing = resolve("artifacts/不存在的内核目录");
    const result = spawnSync(exe, [], {
      input:
        JSON.stringify({
          id: 1,
          method: "init",
          coreDir: missing,
          logDir: resolve("artifacts/encoding-test"),
        }) + "\n",
      encoding: "utf8",
      windowsHide: true,
    });
    const response = JSON.parse(result.stdout.trim());
    expect(response.ok).toBe(false);
    expect(response.error).toContain(missing);
  },
);
it.skipIf(!existsSync(exe))(
  "native bridge error latch and cancellation cannot become success",
  () => {
    const result = spawnSync(exe, ["--self-test"], {
      encoding: "utf8",
      windowsHide: true,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Callback outcome tests passed");
    expect(result.stdout).toContain("Task type allowlist tests passed");
  },
);
it.skipIf(!existsSync(exe))(
  "bridge exits when its supervising parent dies, with stdin still open",
  async () => {
    const parent = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      windowsHide: true,
    });
    const bridge = spawn(exe, ["--parent-pid", String(parent.pid)], {
      windowsHide: true,
      stdio: "pipe",
    });
    try {
      const exited = new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Bridge survived parent death")),
          4000,
        );
        bridge.once("exit", (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      parent.kill();
      expect(await exited).toBe(73);
    } finally {
      parent.kill();
      bridge.kill();
    }
  },
);
