import { describe, expect, it, vi } from "vitest";
import { gameMessageAuthority } from "../packages/agent/game-message-authority";
import { createGameGoalTools } from "../packages/agent/game-tools";
import { createFixtureSnapshot } from "../packages/agent/fixture";
import { createAgentTools } from "../packages/agent/tools";
import { prepareAgentGame } from "../games/agent-execution";
import {
  assertAgentExecutionAccounts,
  assertAgentGameMessageScope,
} from "../games/agent-message-scope";
import type { GoalScope } from "../packages/protocol/agent-goal";

it.each([
  "现在运行两个账号明日方舟日常，阴阳师先不跑",
  "现在运行两个账号明日方舟日常，阴阳师暂时不做",
  "现在运行两个账号阴阳师日常，明日方舟先不执行",
])("keeps a standalone postposed game exclusion local: %s", (prompt) => {
  expect(gameMessageAuthority(prompt).execute).toBe(true);
});
it.each([
  "现在运行两个账号明日方舟日常，先别跑",
  "现在运行两个账号明日方舟日常，明日方舟先不跑",
  "阴阳师先不跑",
])("does not turn a postposed denial into permission: %s", (prompt) => {
  expect(gameMessageAuthority(prompt).execute).toBe(false);
});
it.each([
  "帮我把两个明日方舟号今天的日常清完",
  "帮我把两个明日方舟号今天的日常清完，理智刷LS-6，别吃药也别碎石，阴阳师先不跑。",
  "帮我把两个明日方舟号今天的日常清完，理智刷LS-6，别吃药也别碎石，阴阳师先不跑。跑完告诉我信用还剩多少。",
])(
  "recognizes an explicit daily completion request without a reporting action: %s",
  (prompt) => {
    expect(gameMessageAuthority(prompt)).toMatchObject({
      execute: true,
      stop: false,
      constraints: { medicine: 0, stone: 0, expiringMedicine: 0 },
    });
  },
);
it.each([
  "两个明日方舟号今天的日常清完了",
  "帮我把两个明日方舟号今天的日常清完了",
  "两个明日方舟号今天的日常没清完",
  "帮我把两个明日方舟号今天的日常先不要清完",
  "帮我把两个明日方舟号今天的日常清完，先别跑",
  "帮我把两个明日方舟号今天的日常清完，先不要清完",
  "两个明日方舟号今天的日常清完了，跑完告诉我信用还剩多少",
  "帮我把两个明日方舟号今天的日常先不要清完，跑完告诉我信用还剩多少",
  "跑完告诉我信用还剩多少",
  "帮我记录：两个明日方舟号今天的日常清完",
  "帮我标记两个明日方舟号今天的日常清完",
  "帮我把两个明日方舟号标记成日常清完",
])(
  "does not derive a new action from completion history or reporting: %s",
  (prompt) => {
    expect(gameMessageAuthority(prompt).execute).toBe(false);
  },
);

function compiledLogin(prompt: string) {
  const fixture = createFixtureSnapshot();
  const tools = createAgentTools(fixture);
  const at = "2026-10-05T06:00:00.000Z";
  const draft = tools.call("compile_plan", {
    catalogRevision: tools.call("list_capabilities").revision,
    environmentRevision: tools.call("get_environment").revision,
    at,
    lanes: fixture.lanes!.lanes.map((lane) => ({
      laneId: lane.id,
      games: [{ gameId: "arknights", skillIds: ["login"], parameters: {} }],
    })),
  });
  expect(draft.status).toBe("valid");
  const snapshots = draft.lanes.map((compiled) => {
    const lane = fixture.lanes!.lanes.find(
      (value) => value.id === compiled.laneId,
    )!;
    const profile = fixture.profiles!.profiles.find(
      (value) => value.id === lane.arknights.profileId,
    )!;
    const prepared = prepareAgentGame(compiled.games[0], lane, profile, at);
    return {
      lane,
      arknightsPlan: prepared.plan,
      profile: prepared.profile,
      startedAt: at,
    };
  });
  const scopes: GoalScope[] = snapshots.map((snapshot) => ({
    laneId: snapshot.lane.id,
    gameId: "arknights",
    skillIds: [...snapshot.arknightsPlan.skillIds],
    resources: { medicine: 0, stone: 0, expiringMedicine: 0 },
  }));
  const finalGate = () => {
    assertAgentGameMessageScope(prompt, scopes, snapshots);
    assertAgentExecutionAccounts(
      prompt,
      snapshots.map((snapshot) => snapshot.lane.id),
      fixture.lanes!.lanes,
      fixture.profiles!,
    );
  };
  const accepted = vi.fn();
  const cancel = vi.fn(async () => ({ id: "goal-a" }));
  const resume = vi.fn(async () => ({ id: "goal-a" }));
  const binding = createGameGoalTools({
    principal: { sessionId: "chat-a", turnId: "turn-a", prompt },
    source: "recorded",
    host: {
      assertCurrent: async () => {},
      runSaved: async () => {
        finalGate();
        accepted();
        return { id: "goal-a" };
      },
      runPlan: async () => {
        finalGate();
        accepted();
        return { id: "goal-a" };
      },
      read: async () => ({ id: "goal-a" }),
      wait: async () => ({ id: "goal-a" }),
      cancel,
      resume,
      preferences: async () => ({ saved: true }),
    },
  });
  binding.compiled(draft);
  return {
    binding,
    draft,
    finalGate,
    accepted,
    cancel,
    resume,
    context: { callId: "call-a", signal: new AbortController().signal },
  };
}

it("grants execution only from the fresh message, not a quoted historical request", () => {
  expect(
    gameMessageAuthority("现在按保存计划跑两个账号的日常，不吃药").execute,
  ).toBe(true);
  expect(gameMessageAuthority("只给账号二领取阴阳师邮件").execute).toBe(true);
  expect(
    gameMessageAuthority("之前说过‘运行每日任务’，现在看看结果").execute,
  ).toBe(false);
  expect(gameMessageAuthority("日常完成了吗").execute).toBe(false);
  expect(gameMessageAuthority("给我讲讲怎么做日常").execute).toBe(false);
});

it("preview and explicit withholding dominate an action mentioned in the same message", () => {
  for (const prompt of [
    "以后只给账号二领取明日方舟邮件",
    "以后只给账号二领取阴阳师邮件",
    "今后每天运行两个账号日常",
    "按保存计划运行日常，先给清单，不启动",
    "只预览如何运行每日任务",
    "先检查账号，不要执行游戏任务",
    "这轮不确认启动两个账号",
  ])
    expect(gameMessageAuthority(prompt).execute).toBe(false);
});

it("keeps an explicit game restriction from withholding a different game's requested login", async () => {
  const prompt =
    "现在运行两个账号明日方舟登录，仅login，不启动阴阳师，不执行其他日常";
  expect(gameMessageAuthority(prompt).execute).toBe(true);
  const t = compiledLogin(prompt);
  await expect(
    t.binding.call("run_plan", { planHash: t.draft.planHash }, t.context),
  ).resolves.toEqual({ id: "goal-a" });
  expect(t.accepted).toHaveBeenCalledOnce();
});

it("treats 分别执行 as a two-account action rather than 别执行", async () => {
  const prompt =
    "现在给两个已启用账号分别执行明日方舟登录和 UID 核验，仅执行 login。不要执行其他日常，不启动阴阳师。";
  expect(gameMessageAuthority(prompt).execute).toBe(true);
  const t = compiledLogin(prompt);
  await expect(
    t.binding.call("run_plan", { planHash: t.draft.planHash }, t.context),
  ).resolves.toEqual({ id: "goal-a" });
  expect(t.accepted).toHaveBeenCalledOnce();
});

it("does not add denied task nouns to a login-only request", async () => {
  const prompt =
    "现在运行两个已启用账号的明日方舟登录并核验UID，仅login。不运行其他任务，不购物，不作战，不公招，不吃药，不用源石。";
  const t = compiledLogin(prompt);
  await expect(
    t.binding.call("run_plan", { planHash: t.draft.planHash }, t.context),
  ).resolves.toEqual({ id: "goal-a" });
  expect(t.accepted).toHaveBeenCalledOnce();
});

it("binds mixed server descriptions to their respective accounts rather than filtering the entire batch", () => {
  const f = createFixtureSnapshot();
  const ids = f.lanes!.lanes.map((l) => l.id);
  expect(() =>
    assertAgentExecutionAccounts(
      "现在运行两个账号明日方舟登录。账号一使用B服，账号二使用官服",
      ids,
      f.lanes!.lanes,
      f.profiles!,
    ),
  ).not.toThrow();
  expect(() =>
    assertAgentExecutionAccounts(
      "现在运行两个账号明日方舟登录。账号一使用 B 服，账号二使用官服",
      ids,
      f.lanes!.lanes,
      f.profiles!,
    ),
  ).not.toThrow();
  expect(() =>
    assertAgentExecutionAccounts(
      "现在运行两个账号明日方舟登录。账号一使用官服，账号二使用B服",
      ids,
      f.lanes!.lanes,
      f.profiles!,
    ),
  ).toThrow();
  expect(() =>
    assertAgentExecutionAccounts(
      "现在运行B服和官服的明日方舟登录",
      [ids[0]],
      f.lanes!.lanes,
      f.profiles!,
    ),
  ).toThrow();
});

it.each([
  "现在请别执行明日方舟登录",
  "现在千万别执行明日方舟登录",
  "别执行明日方舟登录",
])("keeps real 别 prohibitions: %s", (prompt) => {
  expect(gameMessageAuthority(prompt).execute).toBe(false);
});

it.each([
  "现在运行明日方舟登录，不启动明日方舟",
  "现在运行明日方舟登录，不启动",
  "现在运行两个游戏，不运行阴阳师",
  "不运行阴阳师，不启动明日方舟",
  "现在运行明日方舟登录，只查询不执行",
])(
  "a game restriction does not relax an ambiguous or withheld instruction: %s",
  (prompt) => {
    expect(gameMessageAuthority(prompt).execute).toBe(false);
  },
);

it("recognizes fresh resume and stop separately from a new task", () => {
  expect(gameMessageAuthority("问题解决了，继续刚才失败的任务").resume).toBe(
    true,
  );
  expect(gameMessageAuthority("停止当前任务").stop).toBe(true);
  expect(gameMessageAuthority("为什么任务停止了").stop).toBe(false);
  expect(gameMessageAuthority("检查上次续跑的结果").resume).toBe(false);
});

it.each(["帮我领账号二的阴阳师邮件", "账号二只领阴阳师邮件"])(
  "recognizes the natural bounded claim verb: %s",
  (prompt) => {
    expect(gameMessageAuthority(prompt).execute).toBe(true);
  },
);
it.each(["继续", "重试", "继续吧", "请继续"])(
  "recognizes a current continuation directive for host target resolution: %s",
  (prompt) => {
    expect(gameMessageAuthority(prompt).resume).toBe(true);
    expect(gameMessageAuthority(prompt).execute).toBe(false);
  },
);
it.each(["停下", "停止", "停一下", "请停下"])(
  "recognizes a current stop directive for host target resolution: %s",
  (prompt) => {
    expect(gameMessageAuthority(prompt).stop).toBe(true);
  },
);
it.each([
  "不要继续",
  "以后继续",
  "可以继续吗？",
  "「继续」",
  "不要停下",
  "以后停下",
  "怎么停止",
])(
  "does not authorize a quoted, denied, future or inquiry short directive: %s",
  (prompt) => {
    expect(gameMessageAuthority(prompt).resume).toBe(false);
    expect(gameMessageAuthority(prompt).stop).toBe(false);
  },
);

it("keeps explicit no-shopping and resource limits for admission checks", () => {
  const authority = gameMessageAuthority(
    "开始明日方舟日常，跳过信用商店，不要购物，不吃药",
  );
  expect(authority.execute).toBe(true);
  expect(authority.constraints).toEqual(
    expect.objectContaining({
      shopping: false,
      medicine: 0,
      stone: 0,
      expiringMedicine: 0,
    }),
  );
});

it("saving a future preference does not authorize an immediate game run", () => {
  for (const prompt of [
    "以后账号一每天只领取明日方舟邮件，保存为默认日常",
    "将明日方舟默认设置为领取邮件，不购物",
    "今后每日运行账号二日常，保存这个偏好",
    "以后失败了继续任务，将这个设成默认设置",
    "以后默认只领取邮件，并运行基建",
    "以后默认只领邮件，同时运行日常",
    "以后遇到失败就取消任务，保存为默认设置",
    "以后账号一只领取邮件，保存偏好，并现在不运行账号一邮件任务",
    "以后账号一只领取邮件，保存偏好，并现在不运行其他任务",
  ]) {
    expect(gameMessageAuthority(prompt).execute).toBe(false);
    expect(gameMessageAuthority(prompt).resume).toBe(false);
    expect(gameMessageAuthority(prompt).stop).toBe(false);
  }
  expect(
    gameMessageAuthority(
      "以后账号一只领取邮件，保存偏好，并现在运行账号一邮件任务",
    ).execute,
  ).toBe(true);
  expect(
    gameMessageAuthority("以后失败先停止，保存偏好，并现在停止当前任务").stop,
  ).toBe(true);
});

const currentBusinessRequest =
  "现在给两个已启用账号完成明日方舟的邮件附件、每日任务奖励，以及阴阳师的邮件附件、免费每日礼包和花合战奖励。先核对今天记录，保留已完成步骤；使用保存的账号和资源限制，不购物、不战斗、不消耗付费资源。请实际执行允许执行的任务，并分别说明已完成、未执行或被阻断的结果。";

it.each([
  currentBusinessRequest,
  "帮我领取明日方舟每日任务奖励，使用保存的账号和资源限制",
  "给两个账号领取阴阳师免费每日礼包，沿用已保存配置",
  "使用已保存的默认设置运行明日方舟每日任务",
  "沿用默认配置运行明日方舟每日任务",
])(
  "using an existing configuration does not request a future preference: %s",
  (prompt) => {
    expect(gameMessageAuthority(prompt).execute).toBe(true);
  },
);

it.each([
  "以后使用保存的账号领取明日方舟每日任务奖励",
  "每天沿用已保存配置运行明日方舟日常",
  "每日使用保存的账号运行明日方舟日常",
  "保存每日任务配置为只领取明日方舟邮件",
  "将每日任务设置为只领取明日方舟邮件，沿用保存的账号",
  "默认只领取明日方舟每日任务奖励，使用已保存配置",
  "沿用保存的账号，将每日任务改为只领取明日方舟邮件",
  "如何使用保存的账号领取明日方舟每日任务奖励？",
  "使用已保存配置可以运行明日方舟每日任务吗？",
  "请不要使用保存的账号运行明日方舟每日任务",
  "‘使用保存的账号运行明日方舟每日任务’",
])(
  "configuration references do not authorize preference, inquiry or denied requests: %s",
  (prompt) => {
    expect(gameMessageAuthority(prompt).execute).toBe(false);
  },
);

it.each([
  "请不要再使用保存的账号运行明日方舟每日任务",
  "请不要再次使用保存的账号运行明日方舟每日任务",
  "别再使用保存的账号运行明日方舟每日任务",
  "请勿使用保存的账号运行明日方舟每日任务",
  "禁止使用保存的账号运行明日方舟每日任务",
  "禁止再次使用保存的账号运行明日方舟每日任务",
  "请不要继续沿用已保存配置运行明日方舟每日任务",
  "请勿再次采用默认配置运行明日方舟每日任务",
  "不再按照已保存配置运行明日方舟每日任务",
  "禁止直接按默认计划执行明日方舟每日任务",
  "请千万别再使用保存的账号运行明日方舟每日任务",
  "不得再次使用保存的账号运行明日方舟每日任务",
  "不许再使用保存的账号运行明日方舟每日任务",
  "不准使用已保存配置运行明日方舟每日任务",
  "禁止 再次 使用已保存配置运行明日方舟每日任务",
  "请不要再使用保存的账号运行明日方舟登录任务",
  "请不要重新使用保存的账号运行明日方舟每日任务",
  "请不要重复使用保存的账号运行明日方舟每日任务",
  "请不要马上使用保存的账号运行明日方舟每日任务",
  "请不要立即使用保存的账号运行明日方舟每日任务",
  "请不要再次尝试使用保存的账号运行明日方舟每日任务",
  "请勿换一种方式采用默认配置运行明日方舟每日任务",
  "禁止明天重新尝试按保存的计划执行明日方舟每日任务",
  "使用保存的配置查询账号但不要重新使用保存的账号运行明日方舟每日任务",
])(
  "denied configuration use cannot authorize a host game action: %s",
  async (prompt) => {
    const x = compiledLogin(prompt);
    expect(gameMessageAuthority(prompt).execute).toBe(false);
    expect(() => x.finalGate()).toThrow(
      expect.objectContaining({ code: "CURRENT_MESSAGE_REQUIRED" }),
    );
    await expect(
      x.binding.call("run_plan", { planHash: x.draft.planHash }, x.context),
    ).rejects.toMatchObject({ code: "MESSAGE_NOT_AUTHORIZED" });
    expect(x.accepted).not.toHaveBeenCalled();
  },
);

it.each([
  "沿用保存配置运行明日方舟每日任务，不吃药",
  "使用已保存配置运行明日方舟每日任务，不使用理智药",
  "请分别使用保存的账号运行明日方舟每日任务，不购物",
  "不吃药，沿用保存配置运行明日方舟每日任务",
  "不要使用理智药；分别使用保存的账号运行明日方舟每日任务",
  "不购物。请使用已保存配置运行明日方舟每日任务",
  "不吃药\n请分别使用保存的账号运行明日方舟每日任务",
])(
  "resource restrictions preserve positive existing-configuration execution: %s",
  (prompt) => {
    expect(gameMessageAuthority(prompt)).toMatchObject({
      execute: true,
      constraints: { medicine: 0, stone: 0, expiringMedicine: 0 },
    });
  },
);

it.each([
  "现在可以运行保存的明日方舟日常吗？",
  "能运行明日方舟日常吗？",
  "如何运行明日方舟日常？",
  "怎样运行明日方舟日常",
  "现在可以按保存计划运行明日方舟日常",
  "是否能运行明日方舟日常",
  "现在可以运行保存的明日方舟日常吗",
  "请告诉我如何运行明日方舟登录任务",
  "请告诉我能运行明日方舟日常吗",
  "请问现在能运行明日方舟日常吗",
  "运行明日方舟日常需要什么条件",
  "请帮我说明运行明日方舟登录任务需要哪些条件",
  "请帮我解释运行明日方舟登录任务的要求",
])(
  "capability and how-to inquiries cannot become a model tool execution: %s",
  async (prompt) => {
    const x = compiledLogin(prompt);
    expect(() => x.finalGate()).toThrow(
      expect.objectContaining({ code: "CURRENT_MESSAGE_REQUIRED" }),
    );
    await expect(
      x.binding.call("run_plan", { planHash: x.draft.planHash }, x.context),
    ).rejects.toMatchObject({ code: "MESSAGE_NOT_AUTHORIZED" });
    await expect(
      x.binding.call(
        "run_saved_daily",
        { scope: "saved" },
        { ...x.context, callId: "call-b" },
      ),
    ).rejects.toMatchObject({ code: "MESSAGE_NOT_AUTHORIZED" });
    expect(x.accepted).not.toHaveBeenCalled();
  },
);

it.each([
  ["能继续原任务吗？", "resume_goal", "resume"],
  ["可以重试原任务吗", "resume_goal", "resume"],
  ["如何继续原任务", "resume_goal", "resume"],
  ["我想知道继续原任务的步骤", "resume_goal", "resume"],
  ["可以停止当前任务吗？", "cancel_goal", "cancel"],
  ["能取消当前任务吗", "cancel_goal", "cancel"],
  ["如何停止当前任务", "cancel_goal", "cancel"],
  ["我想知道停止当前任务的步骤", "cancel_goal", "cancel"],
] as const)(
  "inquiry does not grant recovery or cancellation: %s",
  async (prompt, name, effect) => {
    const x = compiledLogin(prompt);
    await expect(
      x.binding.call(name, { goalId: "goal-a" }, x.context),
    ).rejects.toMatchObject({ code: "MESSAGE_NOT_AUTHORIZED" });
    expect(x[effect]).not.toHaveBeenCalled();
  },
);

const boundedLogin =
  "现在只给两个已启用账号运行明日方舟登录及UID核验任务（仅login）。不运行其他日常、不领取邮件、不购物、不吃药、不用源石、不切换阴阳师。请先调用工具获取环境、能力和技能，再compile_plan。使用run_plan受理。游戏结果回到本轮目标。";
it("admits the exact bounded login request while retaining final game and account gates", async () => {
  const x = compiledLogin(boundedLogin);
  expect(gameMessageAuthority(boundedLogin).execute).toBe(true);
  await x.binding.call("run_plan", { planHash: x.draft.planHash }, x.context);
  expect(x.accepted).toHaveBeenCalledTimes(1);
});

const playerLoginRequest =
  "我已经更新过客户端了。先帮我登录两个明日方舟账号，核对是不是保存的B服和官服账号，回到首页就停，其他日常先不做。";
it.each([
  playerLoginRequest,
  "先帮我登录两个明日方舟账号，核对是否是保存的B服和官服账号，回到首页就停，其他日常先不做。",
  "先登录两个账号的明日方舟，其他日常先不做",
  "帮我登录两个明日方舟账号，完成后告诉我是否成功",
])(
  "admits the player's login directive with identity checks and a stopping boundary: %s",
  async (prompt) => {
    const x = compiledLogin(prompt);
    expect(gameMessageAuthority(prompt)).toMatchObject({
      execute: true,
      resume: false,
      stop: false,
    });
    await expect(
      x.binding.call("run_plan", { planHash: x.draft.planHash }, x.context),
    ).resolves.toEqual({ id: "goal-a" });
    expect(x.accepted).toHaveBeenCalledOnce();
    expect(x.cancel).not.toHaveBeenCalled();
  },
);

it.each([
  "不要登录两个明日方舟账号",
  "不需要登录两个明日方舟账号",
  "先帮我登录两个明日方舟账号，不要登录",
  "先帮我登录两个明日方舟账号，只检查账号",
  "先帮我登录两个明日方舟账号，先别跑",
  "先帮我登录两个明日方舟账号，不要再次登录",
  "先帮我登录两个明日方舟账号，不准登录",
  "先帮我登录两个明日方舟账号，不许登录",
  "先帮我登录两个明日方舟账号，不得登录",
  "先帮我登录两个明日方舟账号，切勿登录",
  "先帮我登录两个明日方舟账号，勿登录",
  "先帮我登录两个明日方舟账号，登录这件事先不要做",
  "我已经登录两个明日方舟账号",
  "登录两个明日方舟账号失败了",
  "登录两个明日方舟账号的任务已取消",
  "登录两个明日方舟账号这件事先不要做",
  "登录两个明日方舟账号，失败了",
  "登录两个明日方舟账号，已经取消了",
  "怎么登录两个明日方舟账号",
  "能登录两个明日方舟账号吗",
  "‘先帮我登录两个明日方舟账号’",
])(
  "does not turn denied, completed, quoted or queried login into execution: %s",
  async (prompt) => {
    const x = compiledLogin(prompt);
    expect(gameMessageAuthority(prompt).execute).toBe(false);
    await expect(
      x.binding.call("run_plan", { planHash: x.draft.planHash }, x.context),
    ).rejects.toMatchObject({ code: "MESSAGE_NOT_AUTHORIZED" });
    expect(x.accepted).not.toHaveBeenCalled();
  },
);

it.each([
  "现在运行明日方舟登录任务，完成后告诉我是否成功",
  "请帮我运行明日方舟登录任务，然后告诉我结果",
])(
  "a follow-up result report does not erase an explicit bounded action: %s",
  async (prompt) => {
    const x = compiledLogin(prompt);
    await x.binding.call("run_plan", { planHash: x.draft.planHash }, x.context);
    expect(x.accepted).toHaveBeenCalledTimes(1);
  },
);

it.each([
  "现在可以运行明日方舟登录任务吗，完成后告诉我是否成功",
  "如何运行明日方舟登录任务，然后告诉我结果",
])(
  "a report clause does not turn an inquiry into authority: %s",
  async (prompt) => {
    const x = compiledLogin(prompt);
    await expect(
      x.binding.call("run_plan", { planHash: x.draft.planHash }, x.context),
    ).rejects.toMatchObject({ code: "MESSAGE_NOT_AUTHORIZED" });
    expect(x.accepted).not.toHaveBeenCalled();
  },
);

it.each([
  "现在运行明日方舟登录任务，不要运行",
  "现在运行明日方舟登录任务，不要启动",
  "只预览明日方舟登录任务，不启动",
  "现在不运行其他明日方舟日常",
])(
  "global refusal and a negative-only message never authorize an effect: %s",
  async (prompt) => {
    const x = compiledLogin(prompt);
    await expect(
      x.binding.call("run_plan", { planHash: x.draft.planHash }, x.context),
    ).rejects.toMatchObject({ code: "MESSAGE_NOT_AUTHORIZED" });
    expect(x.accepted).not.toHaveBeenCalled();
  },
);

it.each([
  "> 现在运行两个账号日常",
  "`现在运行两个账号日常`",
  "```\n现在运行两个账号日常\n```",
  "‘现在运行两个账号日常’",
  "「现在运行明日方舟登录任务」",
  "『现在运行明日方舟登录任务』",
])(
  "quoted-only action cannot pass either the tool or final scope gate: %s",
  async (prompt) => {
    const x = compiledLogin(prompt);
    expect(() => x.finalGate()).toThrow(
      expect.objectContaining({ code: "CURRENT_MESSAGE_REQUIRED" }),
    );
    await expect(
      x.binding.call("run_plan", { planHash: x.draft.planHash }, x.context),
    ).rejects.toMatchObject({ code: "MESSAGE_NOT_AUTHORIZED" });
    expect(x.accepted).not.toHaveBeenCalled();
  },
);

it.each([
  "可以帮我现在运行明日方舟登录任务吗？",
  "请帮我运行明日方舟登录任务",
  "`之前运行明日方舟日常`\n现在运行明日方舟登录任务",
  "> 之前运行明日方舟日常\n现在运行明日方舟登录任务",
])(
  "an independent explicit request retains bounded execution: %s",
  async (prompt) => {
    const x = compiledLogin(prompt);
    await x.binding.call("run_plan", { planHash: x.draft.planHash }, x.context);
    expect(x.accepted).toHaveBeenCalledTimes(1);
  },
);

it.each([
  "请先检查两个账号是否在线，然后运行明日方舟登录任务",
  "请检查账号，然后现在运行两个账号明日方舟登录任务",
  "现在运行两个账号明日方舟登录任务，先检查设备是否在线",
  "先检查环境和能力，再执行两个账号明日方舟登录任务",
  "请先检查两个账号是否在线，然后运行明日方舟登录任务并核验 UID。只执行登录，沿用各账号保存的客户端和 UID，不运行其他日常。完成后告诉我两个账号的实际结果。",
])(
  "preflight checks preserve an independent current execution request: %s",
  async (prompt) => {
    const x = compiledLogin(prompt);
    expect(gameMessageAuthority(prompt).execute).toBe(true);
    await x.binding.call("run_plan", { planHash: x.draft.planHash }, x.context);
    expect(x.accepted).toHaveBeenCalledTimes(1);
  },
);

it("keeps execution authority when the prerequisite account check follows the action", () => {
  expect(
    gameMessageAuthority("现在运行两个账号明日方舟登录任务，先检查账号是否在线")
      .execute,
  ).toBe(true);
});

it.each([
  "请先检查两个账号是否在线，然后可以运行明日方舟登录任务吗？",
  "请检查账号能否运行明日方舟登录任务",
  "请检查账号，然后不要运行明日方舟登录任务",
  "请检查账号，然后只预览明日方舟登录任务",
  "请检查账号，‘然后运行明日方舟登录任务’",
  "以后检查账号，然后运行明日方舟登录任务",
  "请解释如何运行明日方舟登录任务，然后现在运行明日方舟登录任务",
])(
  "preflight wording cannot erase an inquiry or withheld action: %s",
  async (prompt) => {
    const x = compiledLogin(prompt);
    expect(gameMessageAuthority(prompt).execute).toBe(false);
    await expect(
      x.binding.call("run_plan", { planHash: x.draft.planHash }, x.context),
    ).rejects.toMatchObject({ code: "MESSAGE_NOT_AUTHORIZED" });
    expect(x.accepted).not.toHaveBeenCalled();
  },
);

/**
 * 表驱动特征表（characterization table）：把 gameMessageAuthority 当前的
 * 授予/收窄/拒绝语义整体钉住。评审要求未来把"正则授予"改为"结构化确认"
 * 时，这张表就是重构的回归门禁——有意的行为变更必须逐行修改此表并说明。
 */
describe("gameMessageAuthority 表驱动特征表", () => {
  const rows: Array<{
    prompt: string;
    execute?: boolean;
    resume?: boolean;
    stop?: boolean;
    shopping?: false;
  }> = [
    // —— 明确授予 ——
    { prompt: "帮我跑一下两个账号的日常", execute: true },
    { prompt: "现在开始明日方舟日常", execute: true },
    { prompt: "请登录账号一", execute: true },
    { prompt: "领取邮件和奖励", execute: true },
    // 已修复：动词表补 先/清完，带汇报后缀的清完指令可授权
    { prompt: "先把日常清完，然后告诉我结果", execute: true },
    // 已修复：主语词表补 登录，登录类指令不再需要显式主语
    { prompt: "重新登录并继续", execute: true, resume: true },
    // —— 询问不授予 ——
    { prompt: "怎么查看执行结果？", execute: false },
    { prompt: "能不能帮我现在运行一下？", execute: false },
    { prompt: "我的账号配置是什么", execute: false },
    { prompt: "日常需要哪些条件", execute: false },
    // —— 否定收窄 ——
    { prompt: "不要运行明日方舟", execute: false },
    { prompt: "先别跑日常", execute: false },
    { prompt: "暂停一下，不要执行任务", execute: false },
    { prompt: "不运行阴阳师，只跑明日方舟", execute: true },
    // —— 预览/查询仅收窄 ——
    { prompt: "只给我看看计划清单，先别执行", execute: false },
    { prompt: "检查一下账号状态", execute: false },
    // —— 偏好设置不授予当次执行 ——
    { prompt: "以后每天自动跑日常", execute: false },
    { prompt: "把默认日常设成明日方舟", execute: false },
    // —— 续跑 / 停止 ——
    { prompt: "继续", resume: true, execute: false },
    { prompt: "帮我重试一下", resume: true, execute: false },
    { prompt: "停止当前任务", stop: true, execute: false },
    { prompt: "取消", stop: true, execute: false },
    { prompt: "不要停止", stop: false },
    // 已修复：句首停止动词即授予 stop（询问/否定门仍生效）
    { prompt: "停止之后告诉我结果", stop: true, execute: false },
    // —— 历史引用 / 引号内容不授予 ——
    { prompt: '之前说过"帮我跑日常"，现在不跑', execute: false },
    { prompt: "> 帮我运行日常", execute: false },
    // —— 约束 ——
    // 已修复：购物约束补 买商店/逛商店
    { prompt: "跑日常，不要买商店", execute: true, shopping: false },
  ];

  it.each(rows.map((r) => [r.prompt, r] as const))("%s", (_prompt, row) => {
    const authority = gameMessageAuthority(row.prompt);
    expect(authority.execute).toBe(row.execute ?? false);
    expect(authority.resume).toBe(row.resume ?? false);
    expect(authority.stop).toBe(row.stop ?? false);
    if (row.shopping === false)
      expect(authority.constraints.shopping).toBe(false);
  });
});
