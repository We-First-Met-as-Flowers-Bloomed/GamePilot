import { access, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  validateDshRuntime,
  portableDshEntry,
} from "../scripts/dsh-portable-runtime.mjs";
let prepared = false;
const directory = resolve(
  process.env.GAMEPILOT_DSH_TEST_RUNTIME ??
    "integrations/deepseek-harness/runtime",
);
try {
  await access(join(directory, "runtime-build-info.json"));
  prepared = true;
} catch {}

describe("portable DSH runtime admission", () => {
  it("rejects an unprepared directory instead of silently packaging a nonfunctional runtime", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gamepilot-dsh-portable-"));
    try {
      await expect(validateDshRuntime(directory)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("admits fixed runtime code and dependency assets but excludes credentials, sessions, traces and npm bins", () => {
    for (const path of [
      "node/node.exe",
      "node/LICENSE",
      "node_modules/@deepseek-ai/dsh/lib/bin.js",
      "licenses/THIRD_PARTY_NOTICES.json",
      "runtime-build-info.json",
      "plugin.mjs",
      "launcher.mjs",
      "gamepilot.cordis.patch.yml",
      "node-runtime.json",
    ])
      expect(portableDshEntry(path)).toBe(true);
    for (const path of [
      ".env",
      ".env.production",
      "profiles/sdk-minimal/.env",
      "sessions/id/current.jsonl",
      "artifacts/diagnose.mjs",
      "traces/result.json",
      ".gitignore",
      "node_modules/.bin/dsh.cmd",
      "node_modules/.cache/provider.json",
      "node_modules/package/trace.log",
    ])
      expect(portableDshEntry(path)).toBe(false);
  });

  it.skipIf(!prepared)(
    "verifies the actual prepared runtime Node hashes, exact SDK/core version and dependency lock",
    async () => {
      const result = await validateDshRuntime(directory);
      expect(result.dshVersion).toBe("0.2.1-alpha.1");
      expect(result.node.version).toBe("v24.21.0");
      expect(result.installedPackages).toBeGreaterThan(100);
    },
  );
});
