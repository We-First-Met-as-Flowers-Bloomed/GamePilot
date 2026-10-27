import { describe, expect, it } from "vitest";
import {
  arknightsMode,
  gameModePlans,
  onmyojiMode,
  planFor,
  stepsForDay,
} from "../scripts/game-mode/plans";
import { classifyFailure, decideRecovery } from "../scripts/game-mode/recovery";
import {
  planRecovery,
  renderRecovery,
} from "../scripts/game-mode/recovery-device";
import {
  mergeRunOutcomes,
  renderReport,
  summarizeRun,
} from "../scripts/game-mode/report";
import {
  mergeStatus,
  renderDailyReport,
  renderStatus,
} from "../scripts/game-mode/status";
import { planCatchup, renderCatchup } from "../scripts/game-mode/catchup";
import {
  planDisposition,
  renderDisposition,
  taskEvidenceIsTerminal,
} from "../scripts/game-mode/disposition";
import { resolveLiveSkill } from "../scripts/live/skills";
import { OnmyojiDaily } from "../games/onmyoji/daily";

describe("game mode plans", () => {
  it("only names skills that exist in each game's skill table", () => {
    for (const plan of gameModePlans)
      for (const step of plan.steps)
        expect(
          plan.knownSkills,
          `${plan.game} 的 ${step.skill} 不在技能表里`,
        ).toContain(step.skill);
  });

  it("keeps step ids unique and marks the daily must-dos", () => {
    for (const plan of gameModePlans) {
      const ids = plan.steps.map((step) => step.skill);
      expect(new Set(ids).size).toBe(ids.length);
    }
    // 真实玩家视角：这几件是"不做就亏"的。
    for (const skill of [
      "login",
      "check-in",
      "mail",
      "daily-gift",
      "realm-raid",
      "hana-claim",
    ])
      expect(
        onmyojiMode.steps.find((step) => step.skill === skill)?.required,
        `阴阳师 ${skill} 应为必做`,
      ).toBe(true);
    for (const skill of [
      "login",
      "recruit",
      "fight",
      "infrastructure",
      "friends",
      "award",
    ])
      expect(
        arknightsMode.steps.find((step) => step.skill === skill)?.required,
        `方舟 ${skill} 应为必做`,
      ).toBe(true);
    // 麒麟看当日开放，不算欠账；2026-10-25 定稿：集体任务/胧车/寄养不再纳入日常。
    expect(
      onmyojiMode.steps.find((s) => s.skill === "guild-kirin")?.required,
    ).toBe(false);
    expect(onmyojiMode.steps.map((s) => s.skill)).toEqual([
      "login",
      "check-in",
      "mail",
      "daily-gift",
      "guild-kirin",
      "realm-raid",
      "hana-claim",
    ]);
    // 每天只需做一次的动作标了 oncePerDay：同日重复运行直接跳过，避免"已领过"被判 unknown。
    for (const skill of [
      "login",
      "check-in",
      "mail",
      "daily-gift",
      "hana-claim",
    ])
      expect(
        onmyojiMode.steps.find((step) => step.skill === skill)?.oncePerDay,
        `阴阳师 ${skill} 应标 oncePerDay`,
      ).toBe(true);
  });

  it("maps every onmyoji plan step to a real OnmyojiDaily method", () => {
    // 2026-10-15 实机踩过：runner 直接拿技能 id 当方法调（check-in ≠ checkIn），
    // 于是第一个技能之后整条计划都停住了。计划里的每一步都必须能解析出方法。
    for (const step of onmyojiMode.steps) {
      const entry = resolveLiveSkill(step.skill);
      expect(entry, `阴阳师步骤 ${step.skill} 没有 CLI 映射`).toBeTruthy();
      expect(
        typeof (OnmyojiDaily.prototype as unknown as Record<string, unknown>)[
          entry!.method
        ],
        `${step.skill} → ${entry!.method}`,
      ).toBe("function");
    }
  });

  it("filters steps by weekday/weekend without dropping the current daily set", () => {
    const saturday = new Date("2026-10-17T12:00:00+08:00");
    const weekday = new Date("2026-10-15T12:00:00+08:00");
    expect(stepsForDay(arknightsMode, saturday).length).toBe(
      stepsForDay(arknightsMode, weekday).length,
    );
    // 2026-10-25 定稿：阴阳师日常全是常驻步骤（开放与否由技能自己判断），周末工作日一致。
    expect(stepsForDay(onmyojiMode, saturday).length).toBe(
      stepsForDay(onmyojiMode, weekday).length,
    );
    expect(planFor("arknights").game).toBe("arknights");
    expect(() => planFor("nope" as never)).toThrow("未知游戏模式");
  });
});

describe("game mode recovery", () => {
  it("classifies the failures we actually saw", () => {
    expect(
      classifyFailure("登录核验未得到新鲜、同一客户端的双帧主页或个人名片"),
    ).toBe("timing");
    expect(classifyFailure("无法确认普通难度模式，停止")).toBe("anchor-miss");
    expect(classifyFailure("已达上限，无法挑战")).toBe("game-limit");
    expect(classifyFailure("找不到狩猎战入口，界面判据未识别")).toBe(
      "anchor-miss",
    );
    expect(classifyFailure("MaaCore bridge exited (1)")).toBe("transport");
    // 2026-10-15 实机：第一次上号遇到"已重连两次仍断开服务器"，重试后成功。
    expect(classifyFailure("已重连两次仍断开服务器，停止上号")).toBe(
      "transport",
    );
    // 2026-10-22 实测：lane-b 首跑 adb 瞬时 offline，报 `Command failed: ...adb.exe ... get-state`。
    // 该文本既没有「设备未就绪」也没有大写 ADB，按旧规则会误判成 unknown；现明确归为 transport。
    expect(
      classifyFailure(
        "Command failed: D:\\mumu12\\MuMu Player 12\\nx_main\\adb.exe -s 127.0.0.1:16416 shell getprop sys.boot_completed",
      ),
    ).toBe("transport");
    expect(classifyFailure("莫名其妙的一句话")).toBe("unknown");
  });

  it("retries only the retryable classes and stops on anchor misses", () => {
    const step = onmyojiMode.steps[0];
    expect(decideRecovery(step, "timing", 1).action).toBe("retry");
    expect(decideRecovery(step, "transport", 1).action).toBe("retry");
    expect(decideRecovery(step, "unknown", 1).action).toBe("retry");
    // 第二次仍然失败就停，不做无界重放。
    expect(decideRecovery(step, "timing", 2).action).toBe("stop");
    expect(decideRecovery(step, "unknown", 2).action).toBe("stop");
    // 锚点问题重试无用，直接停。
    expect(decideRecovery(step, "anchor-miss", 1).action).toBe("stop");
    // 游戏侧限制允许跳过。
    expect(decideRecovery(step, "game-limit", 1).action).toBe("skip");
  });
});

describe("game mode run merging", () => {
  const laneRun = (
    finishedAt: string,
    outcomes: { skill: string; status?: "succeeded" | "failed" | "blocked" }[],
  ) => ({
    lane: "lane-a",
    laneName: "账号一",
    game: "onmyoji" as const,
    address: "127.0.0.1:16384",
    startedAt: finishedAt,
    finishedAt,
    outcomes: outcomes.map((item) => ({
      skill: item.skill,
      label: item.skill,
      required: true,
      status: item.status ?? ("succeeded" as const),
      summary: "完成",
      attempts: 1,
    })),
  });

  it("keeps earlier steps when a later run only covers part of the plan", () => {
    // 2026-10-15：暖机只跑 login，把当天已跑完 7 步的记录整份覆盖成 1 步。
    const previous = laneRun("2026-10-15T04:00:00.000Z", [
      { skill: "login" },
      { skill: "check-in" },
      { skill: "mail" },
    ]);
    const merged = mergeRunOutcomes(
      previous,
      laneRun("2026-10-15T05:00:00.000Z", [{ skill: "login" }]),
    );
    expect(merged.outcomes.map((item) => item.skill)).toEqual([
      "login",
      "check-in",
      "mail",
    ]);
    expect(merged.startedAt).toBe("2026-10-15T04:00:00.000Z");
    expect(merged.finishedAt).toBe("2026-10-15T05:00:00.000Z");
  });

  it("takes the fresher outcome for a skill that ran again", () => {
    const previous = laneRun("2026-10-15T04:00:00.000Z", [
      { skill: "mail", status: "failed" },
    ]);
    const merged = mergeRunOutcomes(
      previous,
      laneRun("2026-10-15T05:00:00.000Z", [{ skill: "mail" }]),
    );
    expect(merged.outcomes).toHaveLength(1);
    expect(merged.outcomes[0]!.status).toBe("succeeded");
  });

  it("returns the new run untouched when there is nothing to merge", () => {
    const next = laneRun("2026-10-15T05:00:00.000Z", [{ skill: "login" }]);
    expect(mergeRunOutcomes(undefined, next)).toBe(next);
  });

  it("plans a catch-up only for required steps that are neither done nor deliberately skipped", () => {
    // 监督回合最常见的一步：看状态 → 定点补跑。以前要人肉拼 --only，容易漏也容易多跑。
    const status = (
      lane: string,
      game: "onmyoji" | "arknights",
      items: { skill: string; required?: boolean; state: string }[],
    ) =>
      ({
        lane,
        laneName: lane === "lane-a" ? "账号一" : "账号二",
        game,
        items: items.map((item) => ({
          skill: item.skill,
          label: `步骤-${item.skill}`,
          required: item.required ?? true,
          state: item.state as never,
          source: "none" as const,
          detail: "",
        })),
        done: 0,
        missing: [],
      }) as never;
    const combos = planCatchup([
      status("lane-a", "onmyoji", [
        { skill: "login", state: "succeeded" },
        { skill: "mail", state: "failed" },
        { skill: "oboroguruma", required: false, state: "pending" },
        { skill: "guild-quest", state: "skipped" }, // 刻意跳过：不算欠账
      ]),
      status("lane-b", "arknights", [{ skill: "login", state: "succeeded" }]),
    ]);
    expect(combos).toHaveLength(1);
    expect(combos[0]!.lane).toBe("lane-a");
    expect(combos[0]!.skills).toEqual(["mail"]);
    // 实际执行由App到期计划选择，不再提交临时步骤。
    expect(renderCatchup(combos)).toContain("onmyoji-app.mjs --due");
    expect(renderCatchup(combos)).not.toContain("--only");
  });

  it("says so plainly when there is nothing owed", () => {
    expect(renderCatchup([])).toContain("今天没有欠账");
  });

  it("keeps a definite outcome when a later run reports a failure or a blocked placeholder", () => {
    // 2026-10-15 实机：一次失败运行把后面每步都写成 blocked（"上游步骤已停止，本步未执行"），
    // 这些占位把当天早些时候真的做成功的步骤覆盖掉，欠账页从 9/10 谎报成 0/10。
    const earlier = laneRun("2026-10-15T01:00:00.000Z", [
      { skill: "login" },
      { skill: "mail" },
      { skill: "realm-raid" },
    ]);
    const later = laneRun("2026-10-15T02:00:00.000Z", [
      { skill: "login" },
      { skill: "mail", status: "blocked" },
      { skill: "realm-raid", status: "failed" },
    ]);
    const merged = mergeRunOutcomes(earlier, later);
    expect(merged.outcomes.map((item) => item.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
  });
});

describe("game mode today status", () => {
  const plans = [onmyojiMode];
  const lanes = [
    {
      id: "lane-a",
      name: "账号一",
      enabled: { onmyoji: true, arknights: false },
    },
  ];
  const run = (
    skill: string,
    status: "succeeded" | "failed" | "skipped",
    finishedAt: string,
  ) => ({
    lane: "lane-a",
    laneName: "账号一",
    game: "onmyoji" as const,
    address: "127.0.0.1:16384",
    startedAt: finishedAt,
    finishedAt,
    outcomes: [
      {
        skill,
        label: onmyojiMode.steps.find((step) => step.skill === skill)!.label,
        required: true,
        status,
        summary: status,
        attempts: 1,
      },
    ],
  });

  it("prefers the freshest evidence and shows pending steps as pending", () => {
    const statuses = mergeStatus({
      plans,
      lanes,
      requests: [
        {
          requestId: "r1",
          laneId: "lane-a",
          startedAt: "2026-10-15T00:10:00.000Z",
          games: {
            onmyoji: {
              result: "failed",
              steps: [
                {
                  stepId: "login",
                  status: "failed",
                  text: "断线",
                  at: "2026-10-15T00:10:05.000Z",
                },
              ],
            },
          },
        },
      ],
      // 手工补跑晚于 App 那次失败：应盖过它。
      runs: [run("login", "succeeded", "2026-10-15T04:00:00.000Z")],
    });
    const lane = statuses[0];
    const login = lane.items.find((item) => item.skill === "login")!;
    expect(login.state).toBe("succeeded");
    expect(login.source).toBe("game-mode");
    const mail = lane.items.find((item) => item.skill === "mail")!;
    expect(mail.state).toBe("pending");
    // 维护类没记录时不算欠账之外的东西：它仍是必做之外的可选项。
    expect(lane.missing).toContain("邮件附件");
    expect(lane.missing).not.toContain("阴阳寮麒麟（可选）");
  });

  it("keeps an earlier success when nothing newer contradicts it", () => {
    const statuses = mergeStatus({
      plans,
      lanes,
      requests: [
        {
          requestId: "r1",
          laneId: "lane-a",
          finishedAt: "2026-10-15T00:20:00.000Z",
          games: {
            onmyoji: {
              result: "succeeded",
              steps: [
                {
                  stepId: "check-in",
                  status: "succeeded",
                  text: "已确认每日一签完成",
                  at: "2026-10-15T00:20:00.000Z",
                },
              ],
            },
          },
        },
      ],
      runs: [],
    });
    const item = statuses[0].items.find((step) => step.skill === "check-in")!;
    expect(item.state).toBe("succeeded");
    expect(item.source).toBe("app");
  });

  it("renders a headline with the arrears and nothing for finished lanes", () => {
    const statuses = mergeStatus({
      plans,
      lanes,
      requests: [],
      runs: [run("login", "succeeded", "2026-10-15T04:00:00.000Z")],
    });
    const markdown = renderStatus("2026-10-15", statuses);
    expect(markdown).toContain("# 今日完成情况 · 2026-10-15");
    expect(markdown).toContain("**必做欠账");
    expect(markdown).toContain("| ✅ | 上号 | game-mode |");
    expect(markdown).toContain("| ⏳ | 邮件附件 | none |");
  });

  it("reports everything done when every must-do succeeded", () => {
    const statuses = mergeStatus({
      plans,
      lanes,
      requests: [
        {
          requestId: "r1",
          laneId: "lane-a",
          finishedAt: "2026-10-15T00:30:00.000Z",
          games: {
            onmyoji: {
              result: "succeeded",
              steps: onmyojiMode.steps.map((step, index) => ({
                stepId: step.skill,
                status: "succeeded",
                text: "完成",
                at: `2026-10-15T00:${String(10 + index).padStart(2, "0")}:00.000Z`,
              })),
            },
          },
        },
      ],
      runs: [],
    });
    expect(statuses[0].missing).toEqual([]);
    expect(renderStatus("2026-10-15", statuses)).toContain(
      "**必做项全部完成**",
    );
  });

  it("renders one canonical daily report with the run log and next steps", () => {
    const statuses = mergeStatus({
      plans,
      lanes,
      requests: [],
      runs: [run("login", "failed", "2026-10-15T04:00:00.000Z")],
    });
    const markdown = renderDailyReport({
      day: "2026-10-15",
      statuses,
      runs: [run("login", "failed", "2026-10-15T04:00:00.000Z")],
      notes: ["App 账本：3 条当天请求"],
    });
    // 结论、实跑明细、下一步、来源说明都在同一份里。
    expect(markdown).toContain("# 今日完成情况 · 2026-10-15");
    expect(markdown).toContain("## 今天做过什么（实跑明细）");
    expect(markdown).toContain("账号一（lane-a）· 阴阳师：0/1 步");
    expect(markdown).toContain("## 下一步");
    expect(markdown).toContain("App 账本：3 条当天请求");
    expect(markdown).toContain("数据来源：App 账本");
  });
});

describe("uncertain records", () => {
  it("plans disposition only for conclusive failures with coherent evidence", () => {
    // 2026-10-15（P1c）：准入第二道闸门只看"该设备有没有未处置记录"，与游戏无关，
    // 所以"方舟失败 → 阴阳师也跑不了"的真正卡点在这里。处置必须极端保守。
    const statuses = [
      {
        lane: "lane-a",
        laneName: "账号一",
        game: "onmyoji" as const,
        items: [
          {
            skill: "login",
            label: "上号",
            required: true,
            state: "pending" as const,
            source: "none" as const,
            detail: "",
          },
        ],
        done: 0,
        missing: [],
      },
    ];
    const requests = [
      {
        id: "r-failed",
        laneId: "lane-a",
        status: "failed",
        startedAt: "2026-10-15T00:12:00Z",
      },
      {
        id: "r-unknown",
        laneId: "lane-a",
        status: "unknown",
        startedAt: "2026-10-15T00:20:00Z",
      },
      { id: "r-done", laneId: "lane-a", status: "succeeded" },
      { id: "r-other-lane", laneId: "lane-b", status: "failed" },
      {
        id: "r-resolved",
        laneId: "lane-a",
        status: "failed",
        resolution: {
          action: "abandoned" as const,
          at: "2026-10-15T01:00:00Z",
          note: "已处置",
        },
      },
    ];
    const tasks = [
      {
        executionId: "r-failed",
        gameId: "arknights",
        status: "failed",
        steps: [{ skillId: "login", status: "failed" }],
      },
      {
        executionId: "r-unknown",
        gameId: "arknights",
        status: "unknown",
        steps: [{ skillId: "login", status: "unknown" }],
      },
      {
        executionId: "r-done",
        gameId: "arknights",
        status: "succeeded",
        steps: [{ skillId: "login", status: "succeeded" }],
      },
      {
        executionId: "r-other-lane",
        gameId: "arknights",
        status: "failed",
        steps: [{ skillId: "login", status: "failed" }],
      },
      {
        executionId: "r-resolved",
        gameId: "arknights",
        status: "failed",
        steps: [{ skillId: "login", status: "failed" }],
      },
    ];
    const plan = planDisposition({ statuses, requests, tasks });
    expect(plan.map((item) => item.requestId)).toEqual(["r-failed"]);
    expect(plan[0]!.gameId).toBe("arknights");
    expect(plan[0]!.note).toContain("原记录保留");
    expect(renderDisposition(plan)).toContain("可自动处置 1 条");
  });

  it("refuses to dispose when the steps are not all terminal or the status contradicts them", () => {
    const statuses = [
      {
        lane: "lane-a",
        laneName: "账号一",
        game: "onmyoji" as const,
        items: [
          {
            skill: "login",
            label: "上号",
            required: true,
            state: "pending" as const,
            source: "none" as const,
            detail: "",
          },
        ],
        done: 0,
        missing: [],
      },
    ];
    const plan = planDisposition({
      statuses,
      requests: [{ id: "r1", laneId: "lane-a", status: "failed" }],
      tasks: [
        // 还有步骤没跑：说明这次尝试没有完整结论，必须留给现场核对。
        {
          executionId: "r1",
          gameId: "arknights",
          status: "failed",
          steps: [
            { skillId: "login", status: "failed" },
            { skillId: "fight", status: "not-run" },
          ],
        },
      ],
    });
    expect(plan).toEqual([]);
    expect(
      taskEvidenceIsTerminal({
        status: "succeeded",
        steps: [{ status: "failed" }],
      }),
    ).toBe(false);
    expect(renderDisposition([])).toContain("没有可自动处置");
  });
});

describe("device recovery", () => {
  const base = {
    previous: {
      game: "arknights",
      packageName: "com.hypergryph.arknights",
      status: "failed" as const,
    },
    next: { game: "onmyoji" },
    reachable: true,
    instance: 0,
  };

  it("stops the failed game before handing the device to the other engine", () => {
    // 2026-10-15（P1b）：一台设备一次只能有一套引擎在驱动，所以"失败后接着跑另一个游戏"
    // 必须先恢复设备；步骤按代价从小到大，且最后一定要验证。
    expect(planRecovery(base)).toEqual([
      { kind: "check" },
      { kind: "stop-game", packageName: "com.hypergryph.arknights" },
      { kind: "verify" },
    ]);
  });

  it("restarts the instance first when the device is unreachable", () => {
    expect(planRecovery({ ...base, reachable: false })).toEqual([
      { kind: "check" },
      { kind: "restart", instance: 0 },
      { kind: "stop-game", packageName: "com.hypergryph.arknights" },
      { kind: "verify" },
    ]);
    // 已经重启过一轮就不再折腾：宁可让监督回合接手。
    expect(planRecovery({ ...base, reachable: false, attempt: 1 })).toEqual([]);
  });

  it("does nothing when the previous game was fine or there is no next game", () => {
    expect(
      planRecovery({
        ...base,
        previous: { ...base.previous, status: "succeeded" },
      }),
    ).toEqual([]);
    expect(
      planRecovery({
        ...base,
        previous: { ...base.previous, status: "skipped" },
      }),
    ).toEqual([]);
    expect(planRecovery({ ...base, next: undefined })).toEqual([]);
    // 同一个游戏不需要"换引擎"，恢复没有意义。
    expect(planRecovery({ ...base, next: { game: "arknights" } })).toEqual([]);
    expect(renderRecovery([])).toBe("不需要设备恢复。");
    expect(renderRecovery(planRecovery(base))).toContain("强制停掉");
  });
});

describe("game mode report", () => {
  const run = {
    lane: "lane-a",
    laneName: "账号一 · 双游戏",
    game: "onmyoji" as const,
    address: "127.0.0.1:16384",
    startedAt: "2026-10-15T00:00:00.000Z",
    finishedAt: "2026-10-15T00:20:00.000Z",
    outcomes: [
      {
        skill: "login",
        label: "上号",
        required: true,
        status: "succeeded" as const,
        summary: "两帧核对已进入游戏",
        attempts: 1,
      },
      {
        skill: "realm-raid",
        label: "地域鬼王",
        required: true,
        status: "failed" as const,
        failure: { class: "anchor-miss" as const, message: "找不到挑战按钮" },
        attempts: 1,
      },
      {
        skill: "guild-kirin",
        label: "阴阳寮麒麟",
        required: false,
        status: "skipped" as const,
        summary: "今日不可挑战",
        attempts: 1,
      },
    ],
  };

  it("summarises what a player still owes today", () => {
    const summary = summarizeRun(run);
    expect(summary.done).toBe(1);
    expect(summary.total).toBe(3);
    expect(summary.missing).toEqual(["地域鬼王"]);
    expect(summary.skipped).toEqual(["阴阳寮麒麟"]);
  });

  it("renders a readable report with the arrears called out", () => {
    const markdown = renderReport(
      "2026-10-15",
      [run],
      ["组合：lane-a/onmyoji"],
    );
    expect(markdown).toContain("# 游戏模式日报 · 2026-10-15");
    expect(markdown).toContain("账号一 · 双游戏");
    expect(markdown).toContain("| ✅ | 上号 | succeeded |");
    expect(markdown).toContain("**欠账（必做未完成）**：地域鬼王");
    expect(markdown).toContain("组合：lane-a/onmyoji");
    // 可选步骤被跳过时不能算成欠账。
    expect(markdown).not.toContain("**欠账（必做未完成）**：阴阳寮麒麟");
  });
});
