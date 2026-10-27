import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const exe = resolve("dist/maa-bridge/GamePilot.MaaBridge.exe");

it.skipIf(process.platform !== "win32" || !existsSync(exe))(
  "keeps native CRT, Windows and managed diagnostic output off the JSON channel",
  () => {
    const result = spawnSync(exe, ["--self-test-native-output"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split(/\r?\n/);
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { id: 1, ok: true, result: "before native diagnostics" },
      { id: 2, ok: true, result: "after native diagnostics" },
    ]);
    expect(result.stderr).toContain("native CRT diagnostic");
    expect(result.stderr).toContain("native Windows diagnostic");
    expect(result.stderr).toContain("managed diagnostic");
  },
);
