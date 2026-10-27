import { setTimeout as delay } from "node:timers/promises";
import type { Frame, GameDevice, Rect } from "../../packages/runtime/device";
import type { OnmyojiIdentityPorts } from "./identity";
import {
  type OnmyojiIdentityEvidence,
  validateOnmyojiIdentityBinding,
  unconfiguredOnmyojiIdentityEvidence,
  onmyojiIdentityReasons,
  onmyojiIdentityPackages,
} from "../../packages/protocol/onmyoji-identity";
import { findText } from "./policy";

export interface OnmyojiProfilePorts extends Omit<
  OnmyojiIdentityPorts,
  "device"
> {
  device: Pick<GameDevice, "observe" | "packages" | "click">;
}

function validFrame(frame: Frame): boolean {
  return (
    !!frame &&
    frame.width === 1920 &&
    frame.height === 1080 &&
    Array.isArray(frame.texts) &&
    frame.texts.length <= 500 &&
    frame.texts.every(
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
        hit.box[0] + hit.box[2] <= frame.width &&
        hit.box[1] + hit.box[3] <= frame.height,
    )
  );
}
function unsafe(frame: Frame): boolean {
  return frame.texts.some(
    (hit) =>
      hit.score >= 0.7 &&
      /验证码|密码|安全验证|确认购买|是否购买|支付|是否继续|获得奖励|领取成功|^(?:确认|确定|取消|实名认证|切换账号)$/.test(
        hit.text.trim(),
      ),
  );
}
function anchored(frame: Frame, text: RegExp, roi: Rect): boolean {
  return !!findText(
    { ...frame, texts: frame.texts.filter((hit) => hit.score >= 0.9) },
    text,
    roi,
  );
}
/** Captured own-avatar Settings panel, not a friend's namecard or old invented profile title. */
function ownSettings(frame: Frame): boolean {
  return (
    validFrame(frame) &&
    !unsafe(frame) &&
    anchored(frame, /^设置$/, [820, 70, 240, 110]) &&
    anchored(frame, /^(?:新)?昵称$/, [210, 410, 140, 80]) &&
    anchored(frame, /^生日$/, [240, 500, 110, 80]) &&
    anchored(frame, /^音乐$/, [880, 250, 180, 100]) &&
    anchored(frame, /^音效$/, [880, 350, 180, 100])
  );
}
/** Only the current 编号 row. Never normalize a partial digit string or read 曾用编号. */
export function parseOnmyojiSettingsUid(frame: Frame): string | undefined {
  if (!ownSettings(frame)) return undefined;
  const row = frame.texts.filter(
    (hit) =>
      hit.box[0] >= 240 &&
      hit.box[0] + hit.box[2] <= 790 &&
      hit.box[1] >= 575 &&
      hit.box[1] + hit.box[3] <= 650,
  );
  const labels = row.filter((hit) =>
    /^编号(?:\s*[:：]?\s*.*)?$/.test(hit.text.trim()),
  );
  if (labels.length !== 1 || labels[0].score < 0.95) return undefined;
  const label = labels[0];
  // The captured authentication badge is the only other text on this row.
  // Unknown letter/punctuation fragments can be misread UID digits too.
  const values = row.filter(
    (hit) =>
      hit !== label &&
      hit.text.trim().length > 0 &&
      !(
        hit.text.trim() === "已实名认证" &&
        hit.box[0] >= 570 &&
        hit.box[0] + hit.box[2] <= 790
      ),
  );
  const inline = /^编号\s*[:：]?\s*(\d{1,128})$/.exec(label.text.trim());
  if (inline) {
    if (values.length) return undefined;
    return inline[1];
  }
  if (!/^编号\s*[:：]?$/.test(label.text.trim())) return undefined;
  // Count the whole value row before checking confidence/alignment. A distant
  // or low-confidence suffix must never turn the readable prefix into a UID.
  const value = values[0];
  return values.length === 1 &&
    value.score >= 0.95 &&
    /^\d{1,128}$/.test(value.text.trim()) &&
    value.box[0] >= label.box[0] + label.box[2] - 8 &&
    value.box[0] - label.box[0] - label.box[2] <= 100 &&
    Math.abs(value.box[1] - label.box[1]) <= 12
    ? value.text.trim()
    : undefined;
}
function courtyard(frame: Frame): boolean {
  if (
    !validFrame(frame) ||
    unsafe(frame) ||
    ownSettings(frame) ||
    anchored(
      frame,
      /设置|生日|编号|礼包屋|庭院事务|难度选择/,
      [180, 80, 1500, 850],
    )
  )
    return false;
  const safe = {
    ...frame,
    texts: frame.texts.filter((hit) => hit.score >= 0.9),
  };
  const expanded =
    anchored(safe, /^图鉴$/, [100, 950, 200, 130]) &&
    (anchored(safe, /^阴阳术$/, [1400, 950, 220, 130]) ||
      anchored(safe, /^式神录$/, [1600, 950, 220, 130]));
  const hasLayout = (expanded ? [0, -250] : [0]).some((shift) => {
    const summonRoi: Rect = [1520 + shift, 210, 200, 200];
    const upper = findText(safe, /^召$/, summonRoi),
      lower = findText(safe, /^唤$/, summonRoi);
    const summon =
      anchored(safe, /^召唤$/, summonRoi) ||
      !!(
        upper &&
        lower &&
        lower.box[1] > upper.box[1] &&
        lower.box[1] - upper.box[1] <= 100 &&
        Math.abs(lower.box[0] - upper.box[0]) <= 30
      );
    // Account-name text is only a layout anchor; it never supplies identity.
    const landmarks = [
      anchored(safe, /^加成$/, [450, 0, 230, 180]),
      anchored(safe, /^(探索|探)$/, [920 + shift, 160, 200, 220]),
      summon,
    ];
    return landmarks.filter(Boolean).length >= 2;
  });
  return (
    hasLayout &&
    safe.texts.some(
      (hit) =>
        hit.box[0] >= 180 &&
        hit.box[0] <= 320 &&
        hit.box[1] >= 30 &&
        hit.box[1] <= 90,
    )
  );
}

/** Worker-only navigation: fresh device/process checks before every sample and input. */
export async function verifyOnmyojiProfile(
  ports: OnmyojiProfilePorts,
): Promise<OnmyojiIdentityEvidence> {
  ports.signal.throwIfAborted();
  const now = ports.now ?? Date.now;
  if (!ports.identity) return unconfiguredOnmyojiIdentityEvidence(now());
  const expected = validateOnmyojiIdentityBinding(ports.identity);
  const started = now(),
    bound = ports.connectedDevice();
  const evidence: OnmyojiIdentityEvidence = {
    version: 1,
    certification: "profile-uid-v1",
    status: "unknown",
    reason: "profile-anchor-missing",
    candidateMatch: false,
    expected,
    startedAt: new Date(started).toISOString(),
    observedAt: new Date(started).toISOString(),
    ...(bound
      ? { device: { adbPath: bound.adbPath, address: bound.address } }
      : {}),
    frames: [],
    courtyardFrames: [],
  };
  if (!bound) {
    evidence.reason = "device-not-connected";
    return evidence;
  }
  const deadline = new AbortController();
  const signal = AbortSignal.any([ports.signal, deadline.signal]);
  const timer = setTimeout(() => deadline.abort(), 40_000);
  const check = () => {
    signal.throwIfAborted();
    if (now() - started >= 40_000) throw Error("observation-timeout");
    const device = ports.connectedDevice();
    if (device?.adbPath !== bound.adbPath || device?.address !== bound.address)
      throw Error("device-changed");
  };
  const checkProcess = async () => {
    check();
    const installed = (await ports.device.packages(signal)).filter((name) =>
      name.startsWith("com.netease.onmyoji"),
    );
    const packageName =
      installed[0] as (typeof onmyojiIdentityPackages)[number];
    if (
      installed.length !== 1 ||
      !onmyojiIdentityPackages.includes(packageName) ||
      (evidence.packageName !== undefined &&
        evidence.packageName !== packageName)
    )
      throw Error("package-unavailable");
    check();
    if (!(await ports.appProcessRunning(bound, packageName, signal)))
      throw Error("package-not-running");
    check();
    evidence.packageName = packageName;
  };
  const read = async () => {
    await checkProcess();
    const frame = await ports.device.observe(signal);
    check();
    return frame;
  };
  const pause = async () => {
    await (ports.wait ?? ((ms, s) => delay(ms, undefined, { signal: s })))(
      800,
      signal,
    );
    check();
  };
  const click = async (x: number, y: number) => {
    await checkProcess();
    await ports.device.click(x, y, signal);
    check();
  };
  const interval = (a: string, b: string) =>
    Date.parse(b) - Date.parse(a) >= 600 &&
    Date.parse(b) - Date.parse(a) <= 10_000;
  let rejectAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(signal.reason);
    signal.addEventListener("abort", rejectAbort, { once: true });
    if (signal.aborted) rejectAbort();
  });
  try {
    await Promise.race([
      (async () => {
        if (!/^\d+$/.test(expected.roleId))
          throw Error("profile-anchor-missing");
        let frame = await read();
        if (!ownSettings(frame)) {
          if (!courtyard(frame)) {
            evidence.reason = "courtyard-anchor-missing";
            return;
          }
          await pause();
          if (!courtyard(await read())) {
            evidence.reason = "courtyard-anchor-missing";
            return;
          }
          await click(95, 80);
          await pause();
          frame = await read();
        }
        for (let i = 0; i < 2; i++) {
          const uid = parseOnmyojiSettingsUid(frame);
          const at = new Date(now()).toISOString();
          evidence.frames.push({
            observedAt: at,
            ...(uid ? { identity: { roleId: uid } } : {}),
          });
          evidence.observedAt = at;
          if (!uid) return;
          if (uid !== expected.roleId) {
            evidence.status = "mismatch";
            evidence.reason = "identity-mismatch";
            return;
          }
          if (i === 0) {
            await pause();
            frame = await read();
          }
        }
        if (
          !interval(
            evidence.frames[0].observedAt,
            evidence.frames[1].observedAt,
          )
        ) {
          evidence.reason = "sampling-interval";
          return;
        }
        await click(1660, 150);
        evidence.reason = "profile-return-failed";
        for (let i = 0; i < 4; i++) {
          await pause();
          frame = await read();
          const at = new Date(now()).toISOString();
          evidence.observedAt = at;
          if (!courtyard(frame)) {
            evidence.courtyardFrames = [];
            if (!validFrame(frame) || unsafe(frame)) return;
            continue;
          }
          evidence.courtyardFrames!.push(at);
          if (evidence.courtyardFrames!.length === 2) {
            if (!interval(evidence.courtyardFrames![0], at)) {
              evidence.reason = "sampling-interval";
              return;
            }
            evidence.status = "matched";
            evidence.reason = "identity-matched";
            evidence.candidateMatch = true;
            return;
          }
        }
      })(),
      aborted,
    ]);
  } catch (error) {
    ports.signal.throwIfAborted();
    evidence.status = "unknown";
    evidence.candidateMatch = false;
    evidence.reason = deadline.signal.aborted
      ? "observation-timeout"
      : error instanceof Error &&
          onmyojiIdentityReasons.includes(
            error.message as (typeof onmyojiIdentityReasons)[number],
          )
        ? error.message
        : "observation-failed";
  } finally {
    clearTimeout(timer);
    if (rejectAbort) signal.removeEventListener("abort", rejectAbort);
    deadline.abort();
  }
  evidence.observedAt = new Date(now()).toISOString();
  return structuredClone(evidence);
}
