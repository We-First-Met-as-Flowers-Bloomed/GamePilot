#!/usr/bin/env node
// 日常幂等验收：读 artifacts/game-mode/<date>/ 下的运行产物，判定"同一天多次执行是否仍然全部成功"。
//
// 用法：
//   node scripts/acceptance/idempotency.mjs                 # 今天
//   node scripts/acceptance/idempotency.mjs 2026-10-22     # 指定日期
//   node scripts/acceptance/idempotency.mjs 2026-10-22 --json
//
// 多次运行：产物文件会被后续运行覆盖。要做"同日两遍"验收，请在第二遍前把第一遍复制为
//   <lane>-<game>.run1.json（脚本会把它们按 finishedAt 排序聚合）。
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  summarizeDailyIdempotency,
  toDailyRunRecord,
} from "../../packages/runtime/daily-idempotency-core.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 各游戏的"完整日常"步骤表。能力未就绪的游戏不纳入达标口径。 */
const GAME_SKILLS = {
  arknights: {
    ready: true,
    skills: ["login", "recruit", "fight", "infrastructure", "friends", "award"],
  },
  onmyoji: {
    ready: false,
    reason: "阴阳师日常技能开发中（当前仅上号+庭院签到可验证），不纳入达标口径",
    skills: [
      "login",
      "check-in",
      "mail",
      "daily-gift",
      "guild-quest",
      "foster",
      "guild-kirin",
      "realm-raid",
      "oboroguruma",
      "hana-claim",
    ],
  },
};

const args = process.argv.slice(2);
const dateArg = args.find((item) => /^\d{4}-\d{2}-\d{2}$/.test(item));
const date = dateArg ?? new Date().toISOString().slice(0, 10);
const asJson = args.includes("--json");
const dir = join(ROOT, "artifacts", "game-mode", date);

if (!existsSync(dir)) {
  console.error("没有该日期的产物目录: " + dir);
  process.exit(2);
}

function readRun(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return toDailyRunRecord(parsed);
  } catch {
    return null;
  }
}

/** 目录里形如 lane-x-arknights.json / lane-x-arknights.run1.json → 按 (lane, game) 分组 */
const groups = new Map();
for (const name of readdirSync(dir)) {
  const match =
    /^(lane-[A-Za-z0-9_-]+?)-(arknights|onmyoji)(?:\.[A-Za-z0-9_-]+)?\.json$/.exec(
      name,
    );
  if (!match) continue;
  const key = match[1] + "/" + match[2];
  // Invalid matching evidence must fail the group rather than disappear from it.
  const run = readRun(join(dir, name)) ?? {
    startedAt: "",
    finishedAt: "",
    outcomes: [],
  };
  if (!groups.has(key))
    groups.set(key, { lane: match[1], game: match[2], runs: [] });
  groups.get(key).runs.push({ file: name, ...run });
}

const report = [];
for (const { lane, game, runs } of groups.values()) {
  const config = GAME_SKILLS[game];
  const ordered = runs.sort(
    (a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt),
  );
  const summary = summarizeDailyIdempotency(ordered, config.skills);
  const perRun = summary.perRun.map((run, index) => ({
    ...run,
    file: ordered[index].file,
    failed: run.failedSkills,
  }));
  report.push({
    lane,
    game,
    evaluated: config.ready,
    skippedReason: config.ready ? undefined : config.reason,
    runs: perRun.length,
    perRun,
    ok: config.ready ? summary.idempotent : null,
    reasons: summary.reasons,
  });
}

if (asJson) {
  console.log(JSON.stringify({ date, report }, null, 2));
} else {
  console.log("日常幂等验收 · " + date);
  if (report.length === 0)
    console.log("  （没有找到 <lane>-<game>.json 产物）");
  for (const item of report) {
    if (!item.evaluated) {
      console.log(
        "  " +
          item.lane +
          "/" +
          item.game +
          " → 跳过（" +
          item.skippedReason +
          "）",
      );
      continue;
    }
    console.log(
      "  " +
        item.lane +
        "/" +
        item.game +
        " → " +
        (item.ok ? "OK ✓" : "NOT OK ✗") +
        " | 运行次数=" +
        item.runs,
    );
    for (const run of item.perRun) {
      const total =
        run.succeeded + run.skipped + run.failed.length + run.missing.length;
      console.log(
        "      #" +
          run.index +
          " " +
          run.finishedAt +
          " | 成功 " +
          run.succeeded +
          "/" +
          total +
          (run.skipped ? " | 有证据跳过: " + run.skipped : "") +
          (run.failed.length ? " | 失败: " + run.failed.join("、") : "") +
          (run.missing.length ? " | 缺: " + run.missing.join("、") : ""),
      );
    }
    for (const reason of item.reasons) console.log("      " + reason);
  }
  console.log(
    "提示：产物会被后续运行覆盖；做「同日两遍」验收请在第二遍前把第一遍复制为 <lane>-<game>.run1.json。",
  );
}

const evaluated = report.filter((item) => item.evaluated);
const allOk = evaluated.length > 0 && evaluated.every((item) => item.ok);
process.exit(allOk ? 0 : 1);
