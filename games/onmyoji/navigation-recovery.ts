import type { Frame } from "../../packages/runtime/device";
import {
  validateTaskRecord,
  type TaskRecord,
} from "../../packages/protocol/task-record";
import type { IncidentScreen } from "../../packages/protocol/incident-agent";
import { classifyOnmyojiFrame } from "./inspection";
import {
  choreClaimClosePoint,
  dailySignClosePoint,
  hanaPromotionClosePoint,
} from "./policy";
import { onmyojiStepEvidence } from "./evidence";
import { onmyojiReplayBlockers } from "./recovery";

export interface OnmyojiNavigationObservation {
  address: string;
  foregroundPackage?: string;
  observedAt: string;
  frame: Frame;
}

export interface OnmyojiNavigationInput {
  address: string;
  packageName: string;
  startedAt: string;
  now: string;
  frames: readonly [OnmyojiNavigationObservation, OnmyojiNavigationObservation];
  /** Number of navigation inputs already sent under the original lease. */
  attempts?: number;
}

export type OnmyojiNavigationAction =
  | { kind: "at-courtyard" }
  | {
      kind: "tap";
      purpose:
        | "dismiss-reward"
        | "dismiss-promotion"
        | "close-sign"
        | "close-mailbox"
        | "return-from-shop";
      point: [number, number];
    };

export type OnmyojiNavigationBlockReason =
  | "invalid-request"
  | "invalid-frame"
  | "device-mismatch"
  | "package-mismatch"
  | "stale-observation"
  | "unsafe-page"
  | "unstable-page"
  | "navigation-limit";

export type OnmyojiNavigationDecision =
  | {
      ok: true;
      page: IncidentScreen;
      observedAt: string;
      pageVerified: true;
      accountVerified: false;
      action: OnmyojiNavigationAction;
    }
  | {
      ok: false;
      pageVerified: false;
      accountVerified: false;
      reason: OnmyojiNavigationBlockReason;
    };

export interface OnmyojiNavigationRetryEvidence {
  runId: string;
  skillId: string;
  phase: "not-submitted";
  observedAt: string;
  /** This evidence is not role verification or permission to replay. */
  accountVerified: false;
}

const blocked = (
  reason: OnmyojiNavigationBlockReason,
): OnmyojiNavigationDecision => ({
  ok: false,
  pageVerified: false,
  accountVerified: false,
  reason,
});

const timestamp = (value: unknown): number =>
  typeof value === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(
    value,
  )
    ? Date.parse(value)
    : NaN;

/** Reject malformed OCR rather than allowing a partial frame to hide a foreground dialog. */
function validFrame(value: Frame): boolean {
  return Boolean(
    value &&
    value.width === 1920 &&
    value.height === 1080 &&
    Array.isArray(value.texts) &&
    value.texts.length <= 4096 &&
    value.texts.every(
      (hit) =>
        hit &&
        typeof hit.text === "string" &&
        hit.text.length <= 2048 &&
        Number.isFinite(hit.score) &&
        hit.score >= 0 &&
        hit.score <= 1 &&
        Array.isArray(hit.box) &&
        hit.box.length === 4 &&
        hit.box.every(Number.isFinite) &&
        hit.box[0] >= 0 &&
        hit.box[1] >= 0 &&
        hit.box[2] > 0 &&
        hit.box[3] > 0 &&
        hit.box[0] + hit.box[2] <= value.width &&
        hit.box[1] + hit.box[3] <= value.height,
    ),
  );
}

function exitForPage(
  page: IncidentScreen,
  frame: Frame,
): OnmyojiNavigationAction | undefined {
  // Keep the classifier's high-confidence anchor requirement when selecting a layout.
  const safe = {
    ...frame,
    texts: frame.texts.filter((hit) => hit.score >= 0.9),
  };
  const tap = (
    purpose: Extract<OnmyojiNavigationAction, { kind: "tap" }>["purpose"],
    point: [number, number] | null,
  ): OnmyojiNavigationAction | undefined =>
    point ? { kind: "tap", purpose, point } : undefined;
  switch (page) {
    case "onmyoji-courtyard":
      return { kind: "at-courtyard" };
    case "onmyoji-chore-reward":
      return tap("dismiss-reward", choreClaimClosePoint(safe));
    case "onmyoji-sign-reward":
      return tap("close-sign", dailySignClosePoint(safe));
    case "onmyoji-hana-promotion":
      return tap("dismiss-promotion", hanaPromotionClosePoint(safe));
    case "onmyoji-mailbox":
      return tap("close-mailbox", [1765, 185]);
    case "onmyoji-mail-reward":
      return tap("dismiss-reward", [960, 1020]);
    case "onmyoji-illustration-reward":
      return tap("dismiss-reward", [960, 1050]);
    case "onmyoji-courtyard-reward":
      return tap("dismiss-reward", [960, 1030]);
    case "onmyoji-gift-reward":
      return tap("dismiss-reward", [1700, 900]);
    case "onmyoji-shop":
    case "onmyoji-gift-house":
    case "onmyoji-daily-gift-list":
      return tap("return-from-shop", [75, 60]);
    default:
      return undefined;
  }
}

/** Only observed exits are allowed. A known shop is never permission to select or claim a card. */
function sameExit(
  first: OnmyojiNavigationAction,
  second: OnmyojiNavigationAction,
): boolean {
  if (first.kind === "at-courtyard") return second.kind === "at-courtyard";
  return (
    second.kind === "tap" &&
    first.purpose === second.purpose &&
    first.point[0] === second.point[0] &&
    first.point[1] === second.point[1]
  );
}

function interruptedSession(frame: Frame): boolean {
  return frame.texts.some(
    (hit) =>
      hit.score >= 0.7 &&
      /网络(?:连接)?(?:失败|异常|错误|中断)|连接(?:服务器)?(?:失败|超时|中断)|重新(?:连接|登录)|账号(?:异常|冻结|被封)|切换账号|退出登录|身份证|人脸识别|绑定手机|^(?:重试|重新尝试)$/.test(
        hit.text.replace(/\s/g, ""),
      ),
  );
}

/**
 * Pure navigation policy. The host must retain the original device lease and capture
 * two new frames before every input. This does not verify a role or authorize task replay.
 */
export function decideOnmyojiNavigation(
  input: OnmyojiNavigationInput,
): OnmyojiNavigationDecision {
  if (
    !input ||
    typeof input.address !== "string" ||
    !/^[^\s\x00-\x1f\x7f]{1,256}$/.test(input.address) ||
    typeof input.packageName !== "string" ||
    !/^com\.netease\.onmyoji(?:\.[A-Za-z0-9_]+)*$/.test(input.packageName) ||
    !Array.isArray(input.frames) ||
    input.frames.length !== 2 ||
    !Number.isInteger(input.attempts ?? 0) ||
    (input.attempts ?? 0) < 0 ||
    (input.attempts ?? 0) > 3
  )
    return blocked("invalid-request");
  const start = timestamp(input.startedAt),
    now = timestamp(input.now),
    times = input.frames.map((item) => timestamp(item?.observedAt));
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(now) ||
    now < start ||
    now - start > 60000 ||
    times.some(
      (time) =>
        !Number.isFinite(time) ||
        time < start ||
        time > now ||
        now - time > 15000,
    ) ||
    times[1] <= times[0]
  )
    return blocked("stale-observation");
  if (input.frames.some((item) => item.address !== input.address))
    return blocked("device-mismatch");
  if (input.frames.some((item) => item.foregroundPackage !== input.packageName))
    return blocked("package-mismatch");
  if (input.frames.some((item) => !validFrame(item.frame)))
    return blocked("invalid-frame");
  if (input.frames.some((item) => interruptedSession(item.frame)))
    return blocked("unsafe-page");
  const pages = input.frames.map((item) => classifyOnmyojiFrame(item.frame));
  const exits = input.frames.map((item, index) =>
    exitForPage(pages[index], item.frame),
  );
  // Identity, payment, arbitrary confirmation and unknown layers beat background anchors.
  if (!exits[0] || !exits[1]) return blocked("unsafe-page");
  if (pages[0] !== pages[1] || !sameExit(exits[0], exits[1]))
    return blocked("unstable-page");
  if (exits[1].kind === "tap" && (input.attempts ?? 0) === 3)
    return blocked("navigation-limit");
  return {
    ok: true,
    page: pages[1],
    observedAt: input.frames[1].observedAt,
    pageVerified: true,
    accountVerified: false,
    action: exits[1],
  };
}

/**
 * Evidence about the original failed step only. Role verification, current device
 * inspection, admission and replay authorization remain separate host requirements.
 * Legacy messages, screenshots and inferred absence of clicks never become checkpoints.
 */
export function onmyojiNavigationRetryEvidence(
  value: TaskRecord,
): OnmyojiNavigationRetryEvidence | undefined {
  let task: TaskRecord;
  try {
    task = validateTaskRecord(value);
  } catch {
    return;
  }
  const start = timestamp(task.startedAt),
    end = timestamp(task.finishedAt),
    updated = timestamp(task.updatedAt),
    fault = task.fault;
  if (
    task.gameId !== "onmyoji" ||
    task.plan.mode !== "live" ||
    task.status !== "failed" ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    !Number.isFinite(updated) ||
    end < start ||
    updated < end ||
    !fault ||
    fault.source !== "runner" ||
    fault.code !== "skill-exception" ||
    timestamp(fault.observedAt) > end ||
    onmyojiReplayBlockers(task).length
  )
    return;
  const index = task.steps.findIndex((step) => step.skillId === fault.skillId),
    step = task.steps[index];
  if (index < 0 || step.status !== "failed") return;
  const evidence = onmyojiStepEvidence(step),
    stepStart = timestamp(step.startedAt),
    stepEnd = timestamp(step.finishedAt);
  if (
    evidence?.phase !== "not-submitted" ||
    stepStart < start ||
    stepEnd > end ||
    timestamp(evidence.observedAt) > timestamp(fault.observedAt)
  )
    return;
  let previousEnd = start;
  for (const previous of task.steps.slice(0, index)) {
    const from = timestamp(previous.startedAt),
      to = timestamp(previous.finishedAt),
      checkpoint = previous.result?.onmyoji;
    if (
      !["succeeded", "skipped"].includes(previous.status) ||
      !Number.isFinite(from) ||
      !Number.isFinite(to) ||
      from < previousEnd ||
      to < from ||
      to > stepStart ||
      (checkpoint !== undefined &&
        onmyojiStepEvidence(previous)?.phase !== "confirmed")
    )
      return;
    previousEnd = to;
  }
  if (
    task.steps
      .slice(index + 1)
      .some(
        (later) =>
          later.status !== "not-run" ||
          later.startedAt !== undefined ||
          later.finishedAt !== undefined ||
          later.result !== undefined ||
          later.evidence !== undefined,
      )
  )
    return;
  return {
    runId: task.runId,
    skillId: step.skillId,
    phase: "not-submitted",
    observedAt: evidence.observedAt,
    accountVerified: false,
  };
}
