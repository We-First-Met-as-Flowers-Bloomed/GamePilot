import { readFile, writeFile, mkdir, realpath, rename } from "node:fs/promises";
import { resolve, join, relative, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { validateDeviceLanes, validateAutomation } from "../protocol";
import { validateArknightsProfiles } from "../../games/arknights/config";
import { freezeLaneExecution } from "../../apps/desktop/main/lane-snapshot";
import {
  inspectDaily,
  inspectionLabels,
  summarizeDaily,
  type DailyExpectation,
} from "./report";
import { readEvidence, canonical } from "./files";

async function main() {
  const args = process.argv.slice(2),
    flags = new Map<string, string>();
  let init = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--init") {
      init = true;
      continue;
    }
    if (
      !["--data", "--out", "--start"].includes(args[i]) ||
      !args[i + 1] ||
      args[i + 1].startsWith("--")
    )
      throw Error(
        "参数：--data 目录 --out 报告目录 [--init --start YYYY-MM-DD]",
      );
    flags.set(args[i], args[++i]);
  }
  const data = await realpath(
    resolve(flags.get("--data") ?? join(homedir(), ".gamepilot")),
  );
  const out = resolve(flags.get("--out") ?? "artifacts/acceptance-20260926");
  const within = (parent: string, child: string) => {
    const r = relative(parent, child);
    return !r || (!r.startsWith("..") && !isAbsolute(r));
  };
  if (within(data, out)) throw Error("报告目录不能位于生产数据目录内");
  await mkdir(out, { recursive: true });
  if (within(data, await realpath(out)))
    throw Error("报告目录不能链接到生产数据目录");
  const json = async (file: string) => JSON.parse(await readFile(file, "utf8"));
  const configFiles = [
    "device-lanes.json",
    "arknights.json",
    "automation.json",
  ];
  const config = Object.fromEntries(
    await Promise.all(
      configFiles.map(async (f) => [f, await json(join(data, f))]),
    ),
  );
  const baselineFile = join(out, "baseline.json");
  if (init) {
    const start = flags.get("--start");
    if (
      !start ||
      !/^\d{4}-\d{2}-\d{2}$/.test(start) ||
      new Date(start).toISOString().slice(0, 10) !== start
    )
      throw Error("必须提供有效开始日期");
    const lanes = validateDeviceLanes(config["device-lanes.json"]).lanes.filter(
      (l) => l.enabled,
    );
    const profiles = validateArknightsProfiles(config["arknights.json"]);
    const automation = validateAutomation(config["automation.json"]);
    if (
      lanes.length !== 2 ||
      lanes.some((l) => !l.arknights.enabled || !l.onmyoji.enabled)
    )
      throw Error("本次基线要求两个已启用的双游戏账号通道");
    if (!automation.scheduleEnabled || automation.scheduleTime !== "08:00")
      throw Error("验收基线要求08:00日常已启用");
    const expectations: DailyExpectation[] = [];
    for (let day = 0; day < 7; day++) {
      const date = new Date(Date.parse(start) + day * 86400000)
        .toISOString()
        .slice(0, 10);
      for (const lane of lanes) {
        const frozen = freezeLaneExecution(
          lane,
          profiles,
          false,
          new Date(date + "T08:00:00+08:00"),
        );
        expectations.push({
          date,
          laneId: lane.id,
          instance: lane.instance,
          plans: [frozen.arknightsPlan!, frozen.onmyojiPlan!],
        });
        if (automation.secondScheduleEnabled) {
          const evening = freezeLaneExecution(
            lane,
            profiles,
            false,
            new Date(date + "T" + automation.secondScheduleTime + ":00+08:00"),
            "secondary",
          );
          expectations.push({
            date,
            laneId: lane.id,
            instance: lane.instance,
            slot: "secondary",
            dueTime: automation.secondScheduleTime,
            plans: [evening.arknightsPlan!],
          });
        }
      }
    }
    const maintenance = automation.fosterScheduleEnabled
      ? await Promise.all(
          lanes.map(async (l) => ({
            laneId: l.id,
            ...(await json(join(data, "lanes", l.id, "foster-scheduler.json"))),
          })),
        )
      : [];
    await writeFile(
      baselineFile,
      JSON.stringify(
        {
          version: 1,
          capturedAt: new Date().toISOString(),
          data,
          start,
          end: expectations.at(-1)!.date,
          config,
          expectations,
          maintenance,
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
  }
  const baseline = await json(baselineFile);
  if (
    baseline.version !== 1 ||
    baseline.data !== data ||
    !Array.isArray(baseline.expectations) ||
    baseline.expectations.length !==
      (baseline.config?.["automation.json"]?.secondScheduleEnabled ? 28 : 14)
  )
    throw Error("验收基线无效或数据目录不一致");
  const observedAt = new Date(),
    evidence = await readEvidence(data);
  const configChanges = configFiles.filter(
    (f) => canonical(config[f]) !== canonical(baseline.config[f]),
  );
  const daily = baseline.expectations.map((e: DailyExpectation) =>
    inspectDaily(e, evidence.requests, evidence.tasks, observedAt),
  );
  const maintenance = [];
  for (const original of baseline.maintenance) {
    const ledger = await json(
      join(data, "lanes", original.laneId, "foster-scheduler.json"),
    );
    const runs = evidence.requests
      .filter(
        (r) =>
          r.source === "maintenance" &&
          r.laneId === original.laneId &&
          Date.parse(r.startedAt) >= Date.parse(baseline.capturedAt) &&
          Date.parse(r.startedAt) <=
            Math.min(
              observedAt.getTime(),
              Date.parse(baseline.end + "T23:59:59+08:00"),
            ),
      )
      .map((r) => ({
        id: r.id,
        status: r.status,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        steps: evidence.tasks
          .filter(
            (t) =>
              t.executionId === r.id &&
              t.laneId === r.laneId &&
              t.batchId === r.batchId,
          )
          .map((t) => ({
            gameId: t.gameId,
            status: t.status,
            steps: t.steps.map((s) => ({
              skillId: s.skillId,
              status: s.status,
              result: s.result,
            })),
          })),
      }));
    maintenance.push({
      laneId: original.laneId,
      firstDueAt: original.nextRunAt,
      current: ledger,
      runs,
    });
  }
  const report = {
    version: 1,
    observedAt: observedAt.toISOString(),
    window: { start: baseline.start, end: baseline.end },
    dataErrors: evidence.errors,
    configChanges,
    daily,
    summary: summarizeDaily(daily),
    maintenance,
    acceptance: "pending-human-review",
    notes: [
      "只读采集；不会启动游戏或修改任务账本。",
      "未记录的人工介入不等于零介入。缺任务不能推断为关机、掉线或成功。",
      "当前记录未独立证明定时启动来源、退出方舟、全部奖励与账号身份；不能自动宣布七天通过。",
      "续跑链核对不可变请求指纹、原计划和步骤关联；请求状态与时间不属于该指纹认证范围，仍需核对原始账本。",
    ],
  };
  const localTime = (value: string) =>
    Number.isFinite(Date.parse(value))
      ? new Date(value).toLocaleString("zh-CN", {
          timeZone: "Asia/Shanghai",
          hour12: false,
        })
      : "未记录";
  const laneName = (id: string) =>
    String(
      baseline.config["device-lanes.json"].lanes.find(
        (l: { id: string }) => l.id === id,
      )?.name ?? id,
    )
      .replaceAll("|", "\\|")
      .replace(/[\r\n]/g, " ");
  const lines = [
    "# GamePilot 七天观察报告",
    "",
    `采集：${localTime(report.observedAt)}；观察窗口：${baseline.start} 至 ${baseline.end}（北京时间）`,
    "",
    "**本报告不是七天验收通过证明。**",
    "",
    ...report.notes.map((n) => "- " + n),
    "",
    ...evidence.errors.map((e) => "- 数据异常：" + e),
    ...configChanges.map((f) => "- 配置偏离基线：" + f),
    "",
    `观察轮次 ${report.summary.total}；首轮流程结束（未记录续跑） ${report.summary.firstPassFlowEnded}；续跑补齐 ${report.summary.recovered}；部分完成 ${report.summary.partial}；运行中 ${report.summary.running}；未到时间 ${report.summary.pending}；缺任务 ${report.summary.missing}；有续跑介入记录 ${report.summary.withRecordedIntervention}。`,
    "",
    "| 日期 | 通道 | 轮次 | 流程状态 | 原请求状态 | 原请求数 | 已核实续跑数 | 软件版本 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...daily.map(
      (r: ReturnType<typeof inspectDaily>) =>
        `| ${r.date} | ${laneName(r.laneId)} | ${r.slot === "secondary" ? "第二轮·仅方舟" : "第一轮·双游戏"} | ${inspectionLabels[r.state]} | ${r.originalStatus ?? "未记录"} | ${r.requestIds.length} | ${r.continuationIds.length} | ${[
          ...new Set(
            r.progress?.requests.map((p) => p.appVersion ?? "unknown") ?? [
              r.appVersion ?? "未记录",
            ],
          ),
        ]
          .join(" → ")
          .replaceAll("|", "\\|")
          .replace(/[\r\n]/g, " ")} |`,
    ),
    "",
    "## 周期寄养",
    "",
    ...maintenance.map(
      (m) =>
        `- ${laneName(m.laneId)}：首轮到期 ${localTime(m.firstDueAt)}；账本状态 ${m.current.lastStatus}，下次 ${localTime(m.current.nextRunAt)}；本观察期请求 ${m.runs.length} 条。`,
    ),
    "",
    "## 待核对依据",
    "",
    ...daily
      .filter((r: ReturnType<typeof inspectDaily>) => r.notes.length)
      .map(
        (r: ReturnType<typeof inspectDaily>) =>
          `- ${r.date} ${laneName(r.laneId)} ${r.slot === "secondary" ? "第二轮" : "第一轮"}：${r.notes.join("；")}`,
      ),
    "",
  ];
  const stamp =
    observedAt.toISOString().replaceAll(":", "-") + "-" + randomUUID();
  await mkdir(join(out, "snapshots"), { recursive: true });
  const content = JSON.stringify(report, null, 2);
  await writeFile(join(out, "snapshots", stamp + ".json"), content, {
    flag: "wx",
  });
  for (const [file, value] of [
    ["latest.json", content],
    ["latest.md", lines.join("\n")],
  ]) {
    const temp = join(out, file + "." + randomUUID() + ".tmp");
    await writeFile(temp, value);
    await rename(temp, join(out, file));
  }
  console.log(
    `已只读采集 ${daily.length} 个账号轮次；首轮流程结束 ${report.summary.firstPassFlowEnded}；续跑补齐 ${report.summary.recovered}；部分完成 ${report.summary.partial}；未到时间 ${report.summary.pending}；缺任务 ${report.summary.missing}；数据异常 ${evidence.errors.length}。报告：${join(out, "latest.md")}`,
  );
  if (evidence.errors.length) process.exitCode = 2;
}
void main().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
