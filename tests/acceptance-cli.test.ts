import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute, resolve } from "node:path";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { defaultDeviceLanes, validateAutomation } from "../packages/protocol";
import { defaultArknightsProfiles } from "../games/arknights/config";

it("initializes a future two-lane baseline without fostering and never reports pending slots as completed", async () => {
  const root = await mkdtemp(join(tmpdir(), "gp-acceptance-cli-"));
  try {
    const data = join(root, "data"),
      out = join(root, "reports"),
      binary = join(root, "audit.cjs");
    await mkdir(data);
    const automation = validateAutomation({
      scheduleEnabled: true,
      scheduleTime: "08:00",
      fosterScheduleEnabled: false,
    });
    const lanes = defaultDeviceLanes(automation);
    lanes.lanes.push({
      ...structuredClone(lanes.lanes[0]),
      id: "lane-b",
      name: "second",
      instance: 1,
    });
    const config = {
      "device-lanes.json": lanes,
      "arknights.json": defaultArknightsProfiles,
      "automation.json": automation,
    };
    for (const [file, value] of Object.entries(config))
      await writeFile(join(data, file), JSON.stringify(value));
    await build({
      entryPoints: [resolve("packages/acceptance/cli.ts")],
      outfile: binary,
      bundle: true,
      platform: "node",
      target: "node22",
      format: "cjs",
    });
    const start = new Date(Date.now() + 30 * 86400000)
      .toISOString()
      .slice(0, 10);
    const run = (...args: string[]) =>
      promisify(execFile)(
        process.execPath,
        [binary, "--data", data, "--out", out, ...args],
        { windowsHide: true },
      );
    await run("--init", "--start", start);
    const baselineBefore = await readFile(join(out, "baseline.json"), "utf8");
    const baseline = JSON.parse(baselineBefore),
      report = JSON.parse(await readFile(join(out, "latest.json"), "utf8"));
    expect(baseline.expectations).toHaveLength(14);
    expect(baseline.maintenance).toEqual([]);
    expect(baseline.config["automation.json"].fosterScheduleEnabled).toBe(
      false,
    );
    expect(
      baseline.expectations.every((e: any) =>
        e.plans.every((p: any) => !p.skillIds.includes("foster")),
      ),
    ).toBe(true);
    expect(report.acceptance).toBe("observing");
    expect(report.summary).toMatchObject({
      total: 14,
      pending: 14,
      flowEnded: 0,
      recovered: 0,
      partial: 0,
      firstPassFlowEnded: 0,
    });
    expect(await readFile(join(out, "latest.md"), "utf8")).toContain(
      "软件版本",
    );
    await run();
    expect(await readFile(join(out, "baseline.json"), "utf8")).toBe(
      baselineBefore,
    );
    await expect(run("--init", "--start", start)).rejects.toThrow();
    expect(await readFile(join(out, "baseline.json"), "utf8")).toBe(
      baselineBefore,
    );
    for (const [file, value] of Object.entries(config))
      expect(await readFile(join(data, file), "utf8")).toBe(
        JSON.stringify(value),
      );
  } finally {
    const rel = relative(tmpdir(), root);
    if (!rel || rel.startsWith("..") || isAbsolute(rel))
      throw Error("unsafe cleanup");
    await rm(root, { recursive: true, force: true });
  }
});
