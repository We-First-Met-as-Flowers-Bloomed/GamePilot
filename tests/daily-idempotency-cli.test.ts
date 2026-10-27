import { afterEach, describe, expect, it } from "vitest";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const artifacts = resolve(root, "artifacts");
const fixtures: string[] = [];
const skills = [
  "login",
  "recruit",
  "fight",
  "infrastructure",
  "friends",
  "award",
];
const run = (hour: number, status = "succeeded") => ({
  startedAt: `2026-10-22T0${hour}:00:00Z`,
  finishedAt: `2026-10-22T0${hour}:01:00Z`,
  outcomes: skills.map((skill) => ({ skill, status })),
});

function acceptance(records: Record<string, unknown>) {
  mkdirSync(artifacts, { recursive: true });
  const fixture = mkdtempSync(join(artifacts, "daily-idempotency-test-"));
  fixtures.push(fixture);
  for (const path of [
    "scripts/acceptance",
    "packages/runtime",
    "artifacts/game-mode/2026-10-22",
  ])
    mkdirSync(join(fixture, path), { recursive: true });
  for (const path of [
    "scripts/acceptance/idempotency.mjs",
    "packages/runtime/daily-idempotency-core.mjs",
  ])
    copyFileSync(join(root, path), join(fixture, path));
  for (const [file, record] of Object.entries(records))
    writeFileSync(
      join(fixture, "artifacts/game-mode/2026-10-22", file),
      typeof record === "string" ? record : JSON.stringify(record),
    );
  const child = spawnSync(
    process.execPath,
    [
      join(fixture, "scripts/acceptance/idempotency.mjs"),
      "2026-10-22",
      "--json",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  return { code: child.status, ...JSON.parse(child.stdout) };
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    if (!resolve(fixture).startsWith(artifacts + sep))
      throw Error("fixture escaped artifacts");
    rmSync(fixture, { recursive: true, force: true });
  }
});

describe("daily acceptance uses shared evidence policy", () => {
  it("one complete run is insufficient", () => {
    const result = acceptance({ "lane-a-arknights.json": run(1) });
    expect(result.code).toBe(1);
    expect(result.report[0].ok).toBe(false);
  });
  it("two distinct complete runs pass", () => {
    expect(
      acceptance({
        "lane-a-arknights.run1.json": run(1),
        "lane-a-arknights.json": run(2),
      }).code,
    ).toBe(0);
  });
  it("a cancelled rerun fails", () => {
    expect(
      acceptance({
        "lane-a-arknights.run1.json": run(1),
        "lane-a-arknights.json": run(2, "cancelled"),
      }).code,
    ).toBe(1);
  });
  it("never drops malformed evidence beside successful records", () => {
    const result = acceptance({
      "lane-a-arknights.run1.json": run(1),
      "lane-a-arknights.json": run(2),
      "lane-a-arknights.broken.json": "{",
    });
    expect(result.code).toBe(1);
    expect(result.report[0].reasons.join()).toMatch(/无效/);
  });
  it("preserves the unready Onmyoji limitation", () => {
    const result = acceptance({ "lane-a-onmyoji.json": run(1) });
    expect(result.report[0]).toMatchObject({ evaluated: false, ok: null });
    expect(result.report[0].skippedReason).toMatch(/开发中/);
    expect(result.code).toBe(1);
  });
});
