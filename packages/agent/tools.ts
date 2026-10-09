import { createHash } from "node:crypto";
import { canonical } from "../acceptance/files";
import { validateDeviceLanes } from "../protocol";
import { validateArknightsProfiles } from "../../games/arknights/config";
import {
  gameAgentCatalog,
  compileGameDraft,
  validateGameOrder,
} from "../../games/agent";
import {
  agentObject,
  agentDate,
  agentBeijingTime,
  agentString,
  AgentToolError,
  validateCompilePlan,
  type AgentSnapshot,
  type AgentToolName,
  type CompiledDraft,
  type AgentHistoryAssessment,
} from "../protocol/agent";
import { validateTaskRecord } from "../protocol/task-record";
import {
  plannerSettings,
  plannerDefaultSkills,
} from "../../games/agent-configuration";
import { historyGameDay } from "../../games/agent-history";
import { buildIncident } from "./incident";
import {
  agentCompilerVersion,
  builtinAgentSkills,
  maxAgentSkillBodyBytes,
} from "../../games/agent-skills";

const hash = (input: unknown) =>
  createHash("sha256").update(canonical(input)).digest("hex");
const evidenceKind = (value: unknown) =>
  typeof value === "string" &&
  ["adapter-return", "adapter-result", "rehearsal"].includes(value)
    ? value
    : undefined;
const recordedTime = (value: unknown) => {
  try {
    return agentDate(value);
  } catch {
    return undefined;
  }
};

export function createAgentTools(
  input: AgentSnapshot,
  options: { complete?: boolean } = {},
) {
  const snapshot = structuredClone(input);
  // These validators don't recover stores or write configuration.
  if (snapshot.lanes) snapshot.lanes = validateDeviceLanes(snapshot.lanes);
  if (snapshot.profiles)
    snapshot.profiles = validateArknightsProfiles(snapshot.profiles);
  snapshot.tasks = snapshot.tasks.map(validateTaskRecord);
  const gameCatalog = gameAgentCatalog();
  const skillPackages = builtinAgentSkills().map((skill) => {
    const bodyByteLength = Buffer.byteLength(skill.body, "utf8");
    if (bodyByteLength > maxAgentSkillBodyBytes)
      throw new AgentToolError(
        "SKILL_BUDGET",
        "内置技能正文超过固定字节预算，目录未加载",
      );
    return {
      ...skill,
      bodyByteLength,
      bodySha256: createHash("sha256").update(skill.body).digest("hex"),
    };
  });
  const skillDirectory = {
    version: 1,
    revision: hash(skillPackages),
    complete: true as const,
    maxBodyBytes: maxAgentSkillBodyBytes,
    entries: skillPackages.map(({ body: _body, ...entry }) => entry),
  };
  const catalog = {
    version: 1,
    revision: hash({
      compiler: agentCompilerVersion,
      games: gameCatalog,
      skills: skillDirectory,
    }),
    complete: options.complete !== false,
    games: gameCatalog,
    skills: skillDirectory,
    compilerVersion: agentCompilerVersion,
  };
  const revision = hash({
    version: 1,
    source: snapshot.source,
    lanes: snapshot.lanes ?? null,
    profiles: snapshot.profiles ?? null,
    ...(snapshot.source === "recorded"
      ? {
          requests: snapshot.requests,
          tasks: snapshot.tasks,
          history: snapshot.history,
          incidentSignals: snapshot.incidentSignals,
          incidentFaults: snapshot.incidentFaults,
          recordedLogins: snapshot.recordedLogins,
          recordedResults: snapshot.recordedResults,
          recordedProgress: snapshot.recordedProgress,
        }
      : {}),
    ...(snapshot.source === "configured" || snapshot.source === "recorded"
      ? { uidConfigured: snapshot.uidConfigured ?? {} }
      : {}),
  });
  const complete = Boolean(
    snapshot.lanes && snapshot.profiles && !snapshot.errors.length,
  );
  const uidConfigured = (profileId: string, uid?: string) =>
    snapshot.source === "configured" || snapshot.source === "recorded"
      ? snapshot.uidConfigured?.[profileId] === true
      : Boolean(uid);

  function listCapabilities(args: unknown = {}) {
    agentObject(args, []);
    return structuredClone(catalog);
  }
  function readSkill(args: unknown) {
    const value = agentObject(args, ["skillId", "catalogRevision"]);
    const skillId = agentString(value.skillId, "内置技能编号", 64);
    const catalogRevision = agentString(value.catalogRevision, "能力版本");
    if (catalogRevision !== catalog.revision)
      throw new AgentToolError(
        "STALE_CATALOG",
        "能力或技能版本已变化，请重新查询目录",
      );
    const skill = skillPackages.find((entry) => entry.id === skillId);
    if (!skill)
      throw new AgentToolError(
        "UNSUPPORTED_SKILL",
        "只允许读取完整目录中注册的内置技能",
      );
    return structuredClone({
      ...skill,
      catalogRevision: catalog.revision,
      directoryRevision: skillDirectory.revision,
    });
  }
  function getEnvironment(args: unknown = {}) {
    agentObject(args, []);
    return {
      version: 1,
      revision,
      source: snapshot.source,
      capturedAt: recordedTime(snapshot.capturedAt),
      complete,
      historyAvailable: snapshot.historyAvailable !== false,
      history: snapshot.history,
      ...(snapshot.source === "recorded" || snapshot.source === "configured"
        ? {
            historyAssessment: {
              scope:
                snapshot.historyAvailable === false
                  ? "not-read"
                  : "bounded-ledger",
              dailyCompletion: "unknown",
              missingRecordMeans: "unknown",
              canInferNotRun: false,
              canAuthorizeReplay: false,
            } satisfies AgentHistoryAssessment,
          }
        : {}),
      observation: "stored-records-only" as const,
      errors: snapshot.errors.map(
        () => "部分配置或记录未能完整读取，请重新采集",
      ),
      lanes: (snapshot.lanes?.lanes ?? []).map((lane) => {
        const profile = snapshot.profiles?.profiles.find(
          (p) => p.id === lane.arknights.profileId,
        );
        const requests = snapshot.requests
          .filter((r) => r.laneId === lane.id)
          .sort(
            (a, b) =>
              Date.parse(b.startedAt) - Date.parse(a.startedAt) ||
              a.id.localeCompare(b.id),
          );
        return {
          id: lane.id,
          instance: lane.instance,
          enabled: lane.enabled,
          online: "not-probed" as const,
          occupancy: "unknown" as const,
          games: {
            arknights: {
              enabled: lane.arknights.enabled,
              profileId: lane.arknights.profileId,
              profileFound: Boolean(profile),
              uidConfigured: uidConfigured(
                lane.arknights.profileId,
                profile?.expectedUid,
              ),
              identity: "not-inspected" as const,
              clientType: profile?.clientType,
              ...(snapshot.source === "configured" ||
              snapshot.source === "recorded"
                ? {
                    saved: profile ? plannerSettings(profile) : undefined,
                    routine: lane.arknights.routine ?? null,
                    routineMode: lane.arknights.routine ? "custom" : "defaults",
                    defaultSkillIds: plannerDefaultSkills("arknights", profile),
                  }
                : {}),
            },
            onmyoji: {
              enabled: lane.onmyoji.enabled,
              identity: "not-inspected" as const,
              ...(snapshot.source === "configured" ||
              snapshot.source === "recorded"
                ? {
                    routine: lane.onmyoji.routine ?? null,
                    routineMode: lane.onmyoji.routine ? "custom" : "defaults",
                    defaultSkillIds: plannerDefaultSkills("onmyoji"),
                  }
                : {}),
            },
          },
          recordedRequestCount:
            snapshot.historyAvailable === false ? null : requests.length,
          recordedRequests: requests.slice(0, 20).map((r) => {
            const run = getRun({ requestId: r.id });
            return {
              id: r.id,
              requestSource: r.source,
              ...(run.resolution ? { resolution: run.resolution } : {}),
              recordedConclusion: run.recordedConclusion,
              ...(run.recordedProgress
                ? {
                    originalPlan: {
                      rootId: run.recordedProgress.rootId,
                      latestId: run.recordedProgress.latestId,
                      outcome: run.recordedProgress.outcome,
                      wholePlanComplete: run.recordedProgress.wholePlanComplete,
                    },
                  }
                : {}),
              status: r.status,
              startedAt: recordedTime(r.startedAt),
              finishedAt: recordedTime(r.finishedAt),
              progress: {
                complete: run.complete,
                tasks: run.tasks.map((t) => ({
                  gameId: t.gameId,
                  gameDay: t.gameDay,
                  mode: t.mode,
                  status: t.status,
                  steps: t.steps.map((s) => ({
                    skillId: s.skillId,
                    status: s.status,
                  })),
                })),
              },
            };
          }),
        };
      }),
      notes: [
        ...(snapshot.source === "recorded"
          ? [
              "仅展示与当前设备及档案配置相符的历史请求；账号现场身份仍未核验",
              "每槽位最多展示最近20条请求，成功仅适用于原请求任务，不代表今天全部日常完成；running不是实时运行证据",
              "记录为空、范围不足或未关联，都只能说明无法确认；不能据此断言未执行，更不能自动补跑",
            ]
          : []),
        ...(snapshot.historyAvailable === false
          ? ["未读取任务账本，完成状态未知；不能据此补跑或认定成功"]
          : []),
        "磁盘状态不是实时设备探测；running可能来自旧进程",
        "未提供启动或取消工具；本轮查询不获取设备锁",
      ],
    };
  }
  function compilePlan(args: unknown): CompiledDraft {
    const data = validateCompilePlan(args);
    data.lanes.forEach((lane) => validateGameOrder(lane.games));
    const result: CompiledDraft = {
      status: "blocked",
      canExecute: false,
      catalogRevision: catalog.revision,
      compilerVersion: agentCompilerVersion,
      skillRevision: skillDirectory.revision,
      environmentRevision: revision,
      at: data.at,
      lanes: [],
      reasons: [],
      preconditions: [
        ...(snapshot.historyAvailable === false
          ? ["本次未读取任务账本，必须先核对今日完成记录，不能据此补跑"]
          : []),
        "本接口只生成草稿，不授予执行权限",
        "开始时重新校验目录/配置/游戏日期，核对设备占用及当日完成记录",
        "需要新鲜现场身份与页面证据；当前快照不是实时探测",
      ],
    };
    if (!catalog.complete) result.reasons.push("能力目录不完整");
    if (!complete) result.reasons.push("环境配置或账本不完整");
    if (data.catalogRevision !== catalog.revision)
      result.reasons.push("能力版本已变化，请重新查询");
    if (data.environmentRevision !== revision)
      result.reasons.push("环境配置已变化，请重新查询");
    for (const request of data.lanes) {
      const lane = snapshot.lanes?.lanes.find((l) => l.id === request.laneId);
      if (!lane || !lane.enabled) {
        result.reasons.push("设备槽位不存在或未启用");
        continue;
      }
      const profile = snapshot.profiles?.profiles.find(
        (p) => p.id === lane.arknights.profileId,
      );
      for (const game of request.games) {
        if (
          !(game.gameId === "arknights"
            ? lane.arknights.enabled
            : lane.onmyoji.enabled)
        )
          result.reasons.push("所选游戏未在该槽位启用");
        if (game.gameId === "arknights" && !profile)
          result.reasons.push("明日方舟账号档案不存在");
        if (
          game.gameId === "arknights" &&
          !uidConfigured(lane.arknights.profileId, profile?.expectedUid)
        )
          result.preconditions.push(`${lane.id} 尚未绑定UID，必须先确认身份`);
      }
      if (
        snapshot.requests.some(
          (r) =>
            r.laneId === lane.id &&
            (r.status === "running" ||
              (!r.resolution &&
                ["unknown", "failed", "cancelled"].includes(r.status))),
        )
      )
        result.preconditions.push(
          `${lane.id} 有运行中或未知的历史记录，执行前须核对，不能据此重跑`,
        );
    }
    if (result.reasons.length) return result;
    try {
      result.lanes = data.lanes.map((request) => {
        const lane = snapshot.lanes!.lanes.find(
          (l) => l.id === request.laneId,
        )!;
        const profile = snapshot.profiles!.profiles.find(
          (p) => p.id === lane.arknights.profileId,
        );
        return {
          laneId: lane.id,
          instance: lane.instance,
          games: request.games.map((game) =>
            compileGameDraft(game, lane, profile, data.at),
          ),
        };
      });
    } catch (error) {
      if (
        !(error instanceof AgentToolError) ||
        error.code !== "MISSING_CONFIGURATION"
      )
        throw error;
      result.lanes = [];
      result.reasons.push(error.message);
      return result;
    }
    result.status = "valid";
    result.planHash = hash({
      catalogRevision: catalog.revision,
      environmentRevision: revision,
      at: result.at,
      lanes: result.lanes,
    });
    return result;
  }
  function getRun(args: unknown) {
    const v = agentObject(args, ["requestId"]);
    const id = agentString(v.requestId, "请求编号");
    if (snapshot.historyAvailable === false)
      throw new AgentToolError(
        "HISTORY_NOT_LOADED",
        "当前仅采集配置，未读取任务账本，完成状态未知",
      );
    const matches = snapshot.requests.filter((r) => r.id === id);
    if (matches.length !== 1)
      throw new AgentToolError("NOT_FOUND", "未找到唯一的执行请求");
    const request = matches[0];
    const beijingStartedAt = agentBeijingTime(request.startedAt);
    const beijingFinishedAt = agentBeijingTime(request.finishedAt);
    const linked = snapshot.tasks.filter((t) => t.executionId === id);
    const warnings: string[] = [];
    if (snapshot.history?.incompleteRequests.includes(id))
      warnings.push(
        "原记录的账号、实例、批次、原生证据或时间存在缺失/冲突，不能确认原请求完成",
      );
    const rawLane = request.snapshot.lane as { instance?: unknown } | undefined;
    const expected = [
      request.snapshot.plan,
      request.snapshot.arknightsPlan,
      request.snapshot.onmyojiPlan,
    ].filter(Boolean) as { gameId?: unknown }[];
    if (!expected.length || expected.some((p) => typeof p.gameId !== "string"))
      warnings.push("原请求缺少可关联的游戏计划");
    const tasks = linked.filter(
      (t) =>
        t.laneId === request.laneId &&
        t.batchId === request.batchId &&
        (!rawLane || t.instance === rawLane.instance) &&
        expected.some((p) => canonical(p) === canonical(t.plan)),
    );
    if (tasks.length !== linked.length)
      warnings.push("部分步骤关联的槽位或批次不匹配，已排除");
    if (!tasks.length) warnings.push("缺少唯一关联的步骤证据");
    if (
      expected.some(
        (p) => tasks.filter((t) => t.gameId === p.gameId).length !== 1,
      )
    )
      warnings.push("原计划部分游戏的步骤记录缺失或重复");
    if (snapshot.errors.length) warnings.push("账本读取不完整");
    if (
      !recordedTime(request.startedAt) ||
      (request.finishedAt !== undefined && !recordedTime(request.finishedAt)) ||
      tasks.some(
        (task) =>
          !recordedTime(task.updatedAt) ||
          task.steps.some(
            (step) =>
              step.result?.arknights &&
              !recordedTime(step.result.arknights.observedAt),
          ),
      )
    )
      warnings.push("部分记录时间不是有效ISO时间，已过滤相关字段");
    if (
      tasks.some((task) =>
        task.steps.some(
          (step) =>
            (step.evidence !== undefined && !evidenceKind(step.evidence)) ||
            (step.startedAt !== undefined && !recordedTime(step.startedAt)) ||
            (step.finishedAt !== undefined && !recordedTime(step.finishedAt)),
        ),
      )
    )
      warnings.push("部分步骤的证据类型或时间格式无效，已过滤相关字段");
    if (new Set(tasks.map((t) => t.gameId)).size !== tasks.length)
      warnings.push("同一游戏出现多个关联步骤记录，需人工核对");
    if (
      tasks.some(
        (t) =>
          historyGameDay(t.gameId, t.startedAt) !==
          historyGameDay(t.gameId, t.finishedAt ?? t.updatedAt),
      )
    )
      warnings.push("任务跨越游戏日重置点，不能归为单日完成，需逐步核对");
    const recordedConclusion = warnings.length
      ? "unknown"
      : request.status === "failed"
        ? "failed"
        : request.status === "cancelled"
          ? "cancelled"
          : request.status === "succeeded" &&
              tasks.every(
                (t) =>
                  t.plan.mode === "live" &&
                  t.status === "succeeded" &&
                  t.steps.every(
                    (s) =>
                      ["succeeded", "skipped"].includes(s.status) &&
                      ["adapter-return", "adapter-result"].includes(
                        s.evidence ?? "",
                      ),
                  ),
              )
            ? "recorded-plan-complete"
            : "unknown";
    return {
      requestId: id,
      laneId: request.laneId,
      source: snapshot.source,
      capturedAt: recordedTime(snapshot.capturedAt),
      recordedStatus: request.status,
      requestSource: request.source,
      ...(request.resolution
        ? {
            resolution: {
              action: request.resolution.action,
              at: recordedTime(request.resolution.at)!,
            },
          }
        : {}),
      ...(request.startupFault
        ? { startupFault: { ...request.startupFault } }
        : {}),
      recordedConclusion,
      ...(() => {
        const progress =
          snapshot.recordedProgress?.filter((p) => p.requestId === id) ?? [];
        return snapshot.source === "recorded" && progress.length === 1
          ? { recordedProgress: structuredClone(progress[0]) }
          : {};
      })(),
      startedAt: recordedTime(request.startedAt),
      finishedAt: recordedTime(request.finishedAt),
      ...(beijingStartedAt || beijingFinishedAt
        ? {
            recordedTime: {
              timeZone: "Asia/Shanghai" as const,
              ...(beijingStartedAt ? { startedAt: beijingStartedAt } : {}),
              ...(beijingFinishedAt ? { finishedAt: beijingFinishedAt } : {}),
            },
          }
        : {}),
      complete: warnings.length === 0,
      inGameCompletion: "not-verified" as const,
      tasks: tasks.map((task) => ({
        ...(() => {
          const facts =
            snapshot.recordedResults?.filter(
              (r) => r.requestId === id && r.runId === task.runId,
            ) ?? [];
          return snapshot.source === "recorded" &&
            !warnings.length &&
            facts.length === 1
            ? { resultSummary: structuredClone(facts[0].summary) }
            : {};
        })(),
        runId: task.runId,
        gameId: task.gameId,
        gameDay: historyGameDay(task.gameId, task.startedAt),
        finishedGameDay: historyGameDay(
          task.gameId,
          task.finishedAt ?? task.updatedAt,
        ),
        mode: task.plan.mode,
        status: task.status,
        ...(() => {
          const facts =
            snapshot.recordedLogins?.filter(
              (f) => f.requestId === id && f.runId === task.runId,
            ) ?? [];
          const observedAt = recordedTime(facts[0]?.observedAt);
          return snapshot.source === "recorded" &&
            !warnings.length &&
            facts.length === 1 &&
            observedAt
            ? {
                recordedLogin: {
                  status: "matched-at-recorded-time" as const,
                  observedAt,
                  currentIdentity: "not-inspected" as const,
                },
              }
            : {};
        })(),
        updatedAt: recordedTime(task.updatedAt),
        steps: task.steps.map((step) => ({
          skillId: step.skillId,
          status: step.status,
          startedAt: recordedTime(step.startedAt),
          finishedAt: recordedTime(step.finishedAt),
          evidence: evidenceKind(step.evidence),
          ...(step.result?.arknights
            ? {
                native: {
                  submission: step.result.arknights.submission,
                  completion: step.result.arknights.completion,
                  observedAt: recordedTime(step.result.arknights.observedAt),
                  identityEvidencePresent: Boolean(step.result.arknights.login),
                },
              }
            : {}),
        })),
      })),
      warnings,
      notes: [
        "结果来自持久记录，不是现场验证；原生任务结束不保证每项游戏奖励已领取",
        "只返回结构化状态和宿主核验的脱敏结果摘要，未加载或发送原始截图、UID、路径及诊断文本",
        "resultSummary只对应所列runId的观测；缺字段不是零。作战累计与末批结算不能相加，购买或领奖确认次数不是物品数量，未观察到确认不证明没有奖励",
        "recordedProgress只表示记录中的原计划与续跑覆盖，不覆盖recordedStatus/recordedConclusion；取消项不算完成，不代表当前游戏现场、全部奖励或七天通过，也不授予重跑权限",
        "recordedLogin仅证明记录时间的主页身份匹配，不证明当前身份、整套日常或奖励完成；resolution只说明已结束处理，原结果不变，不表示恢复或重跑许可",
      ],
    };
  }
  function getIncident(args: unknown) {
    const v = agentObject(args, ["requestId", "environmentRevision"]);
    if (snapshot.source !== "recorded" || snapshot.historyAvailable !== true)
      throw new AgentToolError(
        "RECORDED_HISTORY_REQUIRED",
        "故障诊断需要脱敏持久记录来源",
      );
    if (agentString(v.environmentRevision, "环境版本") !== revision)
      throw new AgentToolError(
        "ENVIRONMENT_CHANGED",
        "证据版本不符，请重新查询环境及请求编号",
      );
    const run = getRun({ requestId: v.requestId });
    return buildIncident(
      run,
      snapshot.incidentSignals ?? [],
      revision,
      recordedTime(snapshot.capturedAt),
      snapshot.incidentFaults,
    );
  }
  const handlers = {
    list_capabilities: listCapabilities,
    read_skill: readSkill,
    get_environment: getEnvironment,
    compile_plan: compilePlan,
    get_run: getRun,
    get_incident: getIncident,
  };
  return {
    call<N extends AgentToolName>(
      name: N,
      args: unknown = {},
    ): ReturnType<(typeof handlers)[N]> {
      if (!Object.hasOwn(handlers, name))
        throw new AgentToolError(
          "UNKNOWN_TOOL",
          "不支持的工具；只开放已注册的只读/编译工具",
        );
      return handlers[name](args) as ReturnType<(typeof handlers)[N]>;
    },
  };
}
