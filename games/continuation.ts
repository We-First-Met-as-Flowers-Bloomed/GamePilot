import type { ExecutionDetail } from "../packages/protocol/execution-detail";
import type { ExecutionRecord } from "../packages/protocol/execution";
import type {
  ContinuationInput,
  ContinuationPreview,
} from "../packages/protocol/continuation";
import type { Plan } from "../packages/protocol";
import { validatePlan } from "../packages/protocol";
import { games, gamePlugins } from "./registry";
import { preserveCreditShoppingStep } from "./arknights/credit-shopping";
import { arknightsGameDay } from "./arknights/result-policy";
import { gameDay } from "./onmyoji/policy";
import { historyStepStatus } from "./agent-history";
import { validArknightsEvidence } from "./arknights/evidence";
import { onmyojiStepEvidence } from "./onmyoji/evidence";
import { matchesStartupReconciliation } from "./arknights/startup-reconciliation";
import {
  validStartupReconciliationFact,
  type StartupReconciliationFact,
} from "../packages/protocol/startup-reconciliation";
import type { StartupFailureProof } from "./startup-continuation";

export function previewDailyContinuation(
  detail: ExecutionDetail,
  parent: ExecutionRecord,
  now: Date,
  verifiedStartupFacts: StartupReconciliationFact[] = [],
  startupProof?: StartupFailureProof,
): ContinuationPreview {
  const preview: ContinuationPreview = {
    parentId: parent.id,
    fingerprint: parent.fingerprint,
    laneName: detail.request.laneName ?? "账号",
    canContinue: false,
    reasons: [...detail.warnings],
    steps: [],
    defaults: [],
    needsAcknowledgement: false,
  };
  const reasons = preview.reasons;
  const startupUnsubmitted =
    !!startupProof &&
    startupProof.parentId === parent.id &&
    startupProof.fingerprint === parent.fingerprint &&
    Date.parse(startupProof.observedAt) >=
      Date.parse(parent.finishedAt ?? "") &&
    Date.parse(startupProof.observedAt) <= now.getTime() &&
    parent.status === "failed" &&
    !detail.warnings.length &&
    detail.games.every((game) => !game.record);
  // The host verifies both ledgers before supplying these facts. Exact matching
  // still prevents a fact from closing another run's native/business uncertainty.
  const startupReconciled = verifiedStartupFacts.some(
    (fact) =>
      validStartupReconciliationFact(fact) &&
      Date.parse(fact.reconciledAt) <= now.getTime() &&
      matchesStartupReconciliation(
        fact,
        parent,
        detail.games.flatMap((game) => (game.record ? [game.record] : [])),
      ),
  );
  if (!parent.laneId || parent.source === "maintenance")
    reasons.push("仅支持有绑定模拟器的日常或单项请求，不支持寄养维护");
  if (
    !["failed", "cancelled", "unknown"].includes(parent.status) ||
    !parent.finishedAt
  )
    reasons.push("请等待请求明确停止后再继续");
  if (parent.resolution) reasons.push("原请求已结束处理，不能再次续跑");
  if (detail.request.id !== parent.id || !detail.games.length)
    reasons.push("原请求与计划记录不完整");
  let serialStopped = false;
  for (const game of detail.games) {
    const registered = games.find((g) => g.id === game.plan.gameId);
    if (
      !registered ||
      game.plan.mode !== "live" ||
      !["arknights", "onmyoji"].includes(game.plan.gameId)
    ) {
      reasons.push("演练或未适配游戏不能续跑");
      continue;
    }
    try {
      validatePlan(game.plan, games);
    } catch {
      reasons.push("原计划不能通过当前技能校验");
      continue;
    }
    const day = game.plan.gameId === "arknights" ? arknightsGameDay : gameDay;
    if (day(new Date(parent.startedAt)) !== day(now))
      reasons.push(`${registered.name}已跨游戏日，请执行新的日常计划`);
    const missing = !game.record;
    if (missing && !serialStopped && !startupUnsubmitted)
      reasons.push(`${registered.name}缺少可靠步骤记录，不能认定未执行`);
    if (
      game.record &&
      ["running", "queued", "stopping"].includes(game.record.status)
    )
      reasons.push(`${registered.name}仍在运行`);
    const selectable: string[] = [];
    for (const skillId of game.plan.skillIds) {
      const step = game.record?.steps.find((s) => s.skillId === skillId);
      const status = step ? historyStepStatus(step) : undefined;
      const native = step?.result?.arknights;
      const reconciledLogin =
        startupReconciled &&
        game.plan.gameId === "arknights" &&
        skillId === "login";
      const shoppingRetained =
        !!step &&
        (gamePlugins.get(game.plan.gameId).recovery.retainedStep(step) ||
          (game.plan.gameId === "arknights" &&
            preserveCreditShoppingStep(step)));
      const onmyoji = step && onmyojiStepEvidence(step);
      const onmyojiUncertain =
        game.plan.gameId === "onmyoji" &&
        !!step?.result?.onmyoji &&
        (!onmyoji || onmyoji.phase === "submitted");
      const nativeUncertain =
        !!native &&
        (!validArknightsEvidence(native) ||
          (native.submission === "submitted" &&
            native.completion !== "native-confirmed"));
      const classification = reconciledLogin
        ? "pending"
        : nativeUncertain || onmyojiUncertain || status === "unknown"
          ? "blocked"
          : shoppingRetained
            ? "excluded"
            : status === "succeeded" || status === "skipped"
              ? "retained"
              : status === "not-run" ||
                  (missing && (serialStopped || startupUnsubmitted))
                ? "pending"
                : status === "failed" || status === "cancelled"
                  ? "retry"
                  : "blocked";
      preview.steps.push({
        gameId: game.plan.gameId,
        skillId,
        status: classification,
        message: reconciledLogin
          ? "原启动已对账，原执行结果仍未确认；子请求须重新登录核验，不计为原步骤完成"
          : shoppingRetained
            ? game.plan.gameId === "onmyoji"
              ? "业务效果已确认，不重复领取或提交；本步骤返回未完成，原失败保留"
              : "原生商店任务已结束，保留可能发生的购物效果，不重复购买；核验或导航未完成，按部分取消计入原计划"
            : onmyojiUncertain
              ? "业务已提交或效果证据未确认，不能靠确认勾选重做"
              : nativeUncertain
                ? "原生已提交或执行结果未确认，不能靠确认勾选重做"
                : (step?.message ??
                  (classification === "pending"
                    ? startupUnsubmitted
                      ? "宿主确认启动前失败，游戏任务尚未提交；续跑须重新登录核验"
                      : "此前游戏已停止，后续游戏尚未开始"
                    : "缺少可靠执行记录")),
      });
      if (classification === "blocked")
        reasons.push(`${registered.name}的${skillId}执行状态待核对`);
      if (classification === "retry") preview.needsAcknowledgement = true;
      if (classification === "excluded") preview.needsAcknowledgement = true;
      if (
        (skillId !== "login" ||
          (reconciledLogin && game.plan.skillIds.length === 1) ||
          (startupUnsubmitted && game.plan.skillIds.length === 1)) &&
        ["retry", "pending"].includes(classification)
      )
        selectable.push(skillId);
    }
    if (selectable.length)
      preview.defaults.push({ gameId: game.plan.gameId, skillIds: selectable });
    if (
      game.record &&
      ["failed", "cancelled"].includes(game.record.status) &&
      game.record.finishedAt
    )
      serialStopped = true;
  }
  if (!preview.defaults.length) reasons.push("没有待继续的业务任务");
  preview.reasons = [...new Set(reasons)];
  preview.canContinue = !preview.reasons.length;
  return preview;
}
export function continuationPlans(
  preview: ContinuationPreview,
  input: ContinuationInput,
  verifiedStartupFacts: StartupReconciliationFact[] = [],
  startupProof?: StartupFailureProof,
): Plan[] {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (k) =>
        ![
          "parentId",
          "fingerprint",
          "selections",
          "acknowledgePartial",
        ].includes(k),
    ) ||
    input.parentId !== preview.parentId ||
    input.fingerprint !== preview.fingerprint
  )
    throw Error("原请求或进度已变化，请重新读取续跑计划");
  if (!preview.canContinue || preview.successorId)
    throw Error(preview.reasons.join("；") || "此请求已有续跑记录");
  if (
    typeof input.acknowledgePartial !== "boolean" ||
    (preview.needsAcknowledgement && !input.acknowledgePartial)
  )
    throw Error("请先核对现场并确认失败步骤的部分执行情况");
  if (
    !Array.isArray(input.selections) ||
    input.selections.length < 1 ||
    input.selections.length > 2
  )
    throw Error("请选择要继续的业务任务");
  const seen = new Set<string>();
  const unsubmittedLogin = (gameId: string) =>
    !!startupProof &&
    startupProof.parentId === preview.parentId &&
    startupProof.fingerprint === preview.fingerprint &&
    Number.isFinite(Date.parse(startupProof.observedAt)) &&
    preview.defaults.some(
      (selection) =>
        selection.gameId === gameId &&
        selection.skillIds.length === 1 &&
        selection.skillIds[0] === "login",
    ) &&
    preview.steps.filter((step) => step.gameId === gameId).length === 1 &&
    preview.steps.some(
      (step) =>
        step.gameId === gameId &&
        step.skillId === "login" &&
        step.status === "pending",
    );
  const reconciledLogin =
    verifiedStartupFacts.some(
      (fact) =>
        validStartupReconciliationFact(fact) &&
        fact.candidate.originalRequestId === preview.parentId &&
        fact.candidate.originalFingerprint === preview.fingerprint,
    ) &&
    preview.defaults.some(
      (selection) =>
        selection.gameId === "arknights" &&
        selection.skillIds.length === 1 &&
        selection.skillIds[0] === "login",
    ) &&
    preview.steps.some(
      (step) =>
        step.gameId === "arknights" &&
        step.skillId === "login" &&
        step.status === "pending",
    );
  for (const selection of input.selections) {
    if (
      !selection ||
      typeof selection !== "object" ||
      Array.isArray(selection) ||
      Object.keys(selection).some((k) => !["gameId", "skillIds"].includes(k)) ||
      typeof selection.gameId !== "string" ||
      seen.has(selection.gameId) ||
      !Array.isArray(selection.skillIds) ||
      !selection.skillIds.length ||
      selection.skillIds.length > 32 ||
      new Set(selection.skillIds).size !== selection.skillIds.length ||
      selection.skillIds.some(
        (id) =>
          typeof id !== "string" ||
          (id === "login" &&
            !(reconciledLogin && selection.gameId === "arknights") &&
            !unsubmittedLogin(selection.gameId)) ||
          !preview.steps.some(
            (s) =>
              s.gameId === selection.gameId &&
              s.skillId === id &&
              ["retry", "pending"].includes(s.status),
          ),
      )
    )
      throw Error("续跑选择包含已完成、重复或不支持的任务");
    seen.add(selection.gameId);
  }
  // Use the frozen game's and skill's order, never an order supplied by the UI.
  return preview.defaults
    .filter((g) => seen.has(g.gameId))
    .map((g) =>
      validatePlan(
        {
          gameId: g.gameId,
          mode: "live",
          skillIds: [
            "login",
            ...g.skillIds.filter(
              (id) =>
                id !== "login" &&
                input.selections
                  .find((s) => s.gameId === g.gameId)!
                  .skillIds.includes(id),
            ),
          ],
        },
        games,
      ),
    );
}
