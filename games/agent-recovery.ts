import type { Frame } from "../packages/runtime/device";
import type {
  TaskRecord,
  TaskStepRecord,
} from "../packages/protocol/task-record";
import type {
  IncidentScreen,
  IncidentRecoveryAction,
} from "../packages/protocol/incident-agent";
import { validArknightsEvidence } from "./arknights/evidence";
import { classifyArknightsFrame } from "./arknights/inspection";
import { defaultArknightsConfig, arknightsPackage } from "./arknights/config";

/** No free OCR text or coordinates leave the worker. Conservative known-dialog predicate. */
export function recognizeIncidentScreen(
  frame: Frame,
  gameId?: string,
): IncidentScreen {
  if (
    !Number.isFinite(frame.width) ||
    !Number.isFinite(frame.height) ||
    frame.width < 1 ||
    frame.height < 1
  )
    return "unknown";
  // Blocking dialogs take precedence over network text underneath them.
  // Require separate, high-confidence anchors; a brand or login label alone is insufficient.
  if (gameId === "arknights") {
    const updateHits = frame.texts.filter(
      (h) =>
        Number.isFinite(h.score) &&
        h.score >= 0 &&
        h.score <= 1 &&
        h.box.every(Number.isFinite) &&
        h.box[2] > 0 &&
        h.box[3] > 0 &&
        h.box[0] >= frame.width * 0.15 &&
        h.box[1] >= frame.height * 0.2 &&
        h.box[0] + h.box[2] <= frame.width * 0.85 &&
        h.box[1] + h.box[3] <= frame.height * 0.85,
    );
    // A complete observed message identifies the blocker; a weak/partial hint
    // only vetoes network retry and never proves that an update is required.
    if (
      updateHits.some(
        (h) =>
          h.score >= 0.9 &&
          /^当前客户端版本已过时[，,。]?请下载最新客户端[。.!！]?$/.test(
            h.text.replace(/\s/g, ""),
          ),
      )
    )
      return "client-update-required";
    if (
      updateHits.some((h) =>
        /客户端版本已过时|请下载最新客户端/.test(h.text.replace(/\s/g, "")),
      )
    )
      return "unknown";
    const identityHits = frame.texts
      .filter(
        (h) =>
          Number.isFinite(h.score) &&
          h.score >= 0.95 &&
          h.box.every(Number.isFinite) &&
          h.box[2] > 0 &&
          h.box[3] > 0 &&
          h.box[0] >= frame.width * 0.1 &&
          h.box[1] >= frame.height * 0.1 &&
          h.box[0] + h.box[2] <= frame.width * 0.9 &&
          h.box[1] + h.box[3] <= frame.height * 0.9,
      )
      .map((h) => h.text.replace(/\s/g, ""));
    const has = (pattern: RegExp) =>
      identityHits.some((text) => pattern.test(text));
    const sdk = has(
      /^(?:哔哩哔哩(?:游戏)?|bilibili(?:游戏)?|哔哩游戏|B站账号登录)$/i,
    );
    const login = has(
      /^(?:登录|立即登录|账号登录|账号密码登录|密码登录|手机号登录|手机验证码登录|验证码登录)$/,
    );
    const credential = has(
      /^(?:请输入(?:账号|用户名|密码)|账号[：:]?|密码[：:]?)$/,
    );
    const phone = has(
      /^(?:请输入手机号|手机号码[：:]?|手机号[：:]?|手机号登录|手机验证码登录)$/,
    );
    const code = has(
      /^(?:请输入(?:短信)?验证码|短信验证码[：:]?|安全验证|滑动验证|拖动滑块.*|验证码已发送.*)$/,
    );
    const codeAction = has(
      /^(?:确认|确定|验证|登录|立即登录|安全验证|完成验证)$/,
    );
    if (sdk && code && codeAction) return "verification-code";
    if (sdk && phone && login && has(/^(?:获取验证码|发送验证码)$/))
      return "phone-login";
    if (sdk && credential && login) return "sdk-login";
    if (
      (credential && login) ||
      (phone && login) ||
      (code && codeAction) ||
      (sdk && (credential || phone || code))
    )
      return "unknown";
  }
  const network = frame.texts.some(
    (h) =>
      h.score >= 0.95 &&
      h.box.every(Number.isFinite) &&
      h.box[2] > 0 &&
      h.box[3] > 0 &&
      h.box[0] >= frame.width * 0.15 &&
      h.box[1] >= frame.height * 0.2 &&
      h.box[0] + h.box[2] <= frame.width * 0.85 &&
      h.box[1] + h.box[3] <= frame.height * 0.85 &&
      /(?:网络|连接|通讯).*(?:失败|异常|中断|错误)|无法连接服务器/.test(
        h.text.replace(/\s/g, ""),
      ),
  );
  if (network) return "network-error";
  if (gameId === "arknights") {
    const page = classifyArknightsFrame(
      frame,
      arknightsPackage(defaultArknightsConfig),
      defaultArknightsConfig,
    ).page;
    if (["home", "profile", "friends-list", "credit-shop"].includes(page))
      return page as IncidentScreen;
  }
  return "unknown";
}

/** Only an unsubmitted login can be retried automatically. Existing host admission still applies. */
export function allowIncidentRetry(
  task: TaskRecord,
  page: IncidentScreen,
  attempts: number,
): boolean {
  const failed = task.steps.filter((s) => s.status === "failed");
  const native = failed[0]?.result?.arknights;
  return (
    Number.isInteger(attempts) &&
    attempts >= 0 &&
    attempts < 2 &&
    task.plan.mode === "live" &&
    task.gameId === "arknights" &&
    task.status === "failed" &&
    page === "network-error" &&
    task.fault?.source === "runner" &&
    task.fault.code === "skill-exception" &&
    task.fault.skillId === "login" &&
    failed.length === 1 &&
    failed[0].skillId === "login" &&
    validArknightsEvidence(native) &&
    native.taskType === "StartUp" &&
    native.submission === "not-submitted" &&
    native.completion === "not-started" &&
    task.steps.every((s) => s.skillId === "login" || s.status === "not-run")
  );
}

/** Shopping may have completed before navigation failed. This never authorizes another purchase. */
export function retainedIncidentNativeStep(step: TaskStepRecord): boolean {
  const e = step.result?.arknights;
  return (
    step.skillId === "friends" &&
    step.status === "failed" &&
    validArknightsEvidence(e) &&
    e.taskType === "Mall" &&
    e.submission === "submitted" &&
    e.completion === "native-confirmed" &&
    Number.isFinite(Date.parse(step.startedAt ?? "")) &&
    Number.isFinite(Date.parse(step.finishedAt ?? "")) &&
    Date.parse(e.observedAt) >= Date.parse(step.startedAt!) &&
    Date.parse(e.observedAt) <= Date.parse(step.finishedAt!) &&
    e.statistics?.mall?.finalCredit !== undefined &&
    e.statistics.mall.finalCredit <= 300
  );
}
/** An unknown/submitted operation cannot become a retry solely because its screen looks familiar. */
export function incidentReplayBlockers(task: TaskRecord): string[] {
  if (task.gameId !== "arknights") return [];
  const types: Record<string, string> = {
    login: "StartUp",
    fight: "Fight",
    friends: "Mall",
    award: "Award",
    recruit: "Recruit",
    infrastructure: "Infrast",
  };
  return task.steps
    .filter((step) => {
      if (
        ["succeeded", "skipped"].includes(step.status) ||
        retainedIncidentNativeStep(step)
      )
        return false;
      if (step.status === "not-run")
        return Boolean(step.startedAt || step.result);
      const e = step.result?.arknights;
      return (
        !["failed", "cancelled"].includes(step.status) ||
        !validArknightsEvidence(e) ||
        e.taskType !== types[step.skillId] ||
        e.submission !== "not-submitted" ||
        e.completion !== "not-started"
      );
    })
    .map((step) => `${step.skillId}的原生提交或执行结果未确认，不能重做`);
}
/** Historical page evidence only proposes navigation. Fresh observation and the target lease are mandatory. */
export function proposeIncidentRecovery(
  task: TaskRecord,
  page: IncidentScreen,
  attempts: number,
): IncidentRecoveryAction | undefined {
  if (
    !Number.isInteger(attempts) ||
    attempts < 0 ||
    attempts >= 2 ||
    task.gameId !== "arknights" ||
    task.plan.mode !== "live" ||
    task.status !== "failed" ||
    task.fault?.source !== "runner" ||
    !["home", "profile", "friends-list", "credit-shop"].includes(page) ||
    incidentReplayBlockers(task).length
  )
    return;
  return {
    kind: "return-arknights-home",
    gameId: "arknights",
    runId: task.runId,
    fromPage: page as IncidentRecoveryAction["fromPage"],
  };
}
