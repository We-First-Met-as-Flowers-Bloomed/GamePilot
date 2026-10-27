import type { GameDevice, Frame, TextHit } from "../../packages/runtime/device";
import { setTimeout as delay } from "node:timers/promises";
import type { Device } from "../../packages/protocol";
import type {
  OnmyojiIdentityBinding,
  OnmyojiIdentityEvidence,
} from "../../packages/protocol/onmyoji-identity";
import {
  validateOnmyojiIdentityBinding,
  sameOnmyojiIdentity,
  unconfiguredOnmyojiIdentityEvidence,
  onmyojiIdentityReasons,
} from "../../packages/protocol/onmyoji-identity";
export interface OnmyojiIdentityPorts {
  identity?: OnmyojiIdentityBinding;
  device: Pick<GameDevice, "observe" | "packages">;
  appProcessRunning(
    device: Device,
    packageName: string,
    signal: AbortSignal,
  ): Promise<boolean>;
  connectedDevice(): Device | undefined;
  signal: AbortSignal;
  now?: () => number;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}
/** Experimental passive parser. These labels have no certified real-device fixture yet. */
export function parseOnmyojiProfileCandidate(
  frame: Frame,
): OnmyojiIdentityBinding | undefined {
  if (
    !frame ||
    frame.width !== 1920 ||
    frame.height !== 1080 ||
    !Array.isArray(frame.texts) ||
    frame.texts.length > 500 ||
    frame.texts.some((hit) => !hit || typeof hit !== "object")
  )
    return undefined;
  const hits = frame.texts.filter(
    (hit) =>
      typeof hit.text === "string" &&
      hit.text.length <= 256 &&
      Number.isFinite(hit.score) &&
      hit.score >= 0.9 &&
      Array.isArray(hit.box) &&
      hit.box.length === 4 &&
      hit.box.every(Number.isFinite) &&
      hit.box[0] >= 0 &&
      hit.box[1] >= 0 &&
      hit.box[2] > 0 &&
      hit.box[3] > 0 &&
      hit.box[0] + hit.box[2] <= frame.width &&
      hit.box[1] + hit.box[3] <= frame.height,
  );
  const titles = hits.filter((hit) =>
    /^(角色资料|个人资料)$/.test(hit.text.trim()),
  );
  if (titles.length !== 1) return undefined;
  function field(
    label: RegExp,
    inline: RegExp,
    valid: (value: string) => boolean,
  ): { value: string; hit: TextHit } | undefined {
    const found: { value: string; hit: TextHit }[] = [];
    for (const hit of hits) {
      const value = inline.exec(hit.text.trim())?.[1]?.trim();
      if (value && valid(value)) found.push({ value, hit });
      else if (label.test(hit.text.trim())) {
        const aligned = hits.filter(
          (entry) =>
            entry !== hit &&
            valid(entry.text.trim()) &&
            entry.box[0] >= hit.box[0] + hit.box[2] - 8 &&
            entry.box[0] - hit.box[0] - hit.box[2] <= frame.width * 0.12 &&
            Math.min(entry.box[1] + entry.box[3], hit.box[1] + hit.box[3]) -
              Math.max(entry.box[1], hit.box[1]) >=
              Math.min(entry.box[3], hit.box[3]) * 0.6,
        );
        if (aligned.length !== 1) return undefined;
        found.push({ value: aligned[0].text.trim(), hit });
      }
    }
    return found.length === 1 ? found[0] : undefined;
  }
  const role = field(
    /^(角色编号|角色ID)[:：]?$/i,
    /^(?:角色编号|角色ID)\s*[:：]\s*(.+)$/i,
    (value) => /^\d+$/.test(value) && value.length <= 128,
  );
  const server = field(
    /^(服务器|所在服务器)[:：]?$/,
    /^(?:服务器|所在服务器)\s*[:：]\s*(.+)$/,
    (value) =>
      value.length > 0 &&
      value.length <= 80 &&
      !/[\x00-\x1f\x7f-\x9f]/.test(value),
  );
  if (
    !role ||
    !server ||
    Math.abs(role.hit.box[0] - server.hit.box[0]) > frame.width * 0.08
  )
    return undefined;
  const title = titles[0];
  if (
    [role.hit, server.hit].some(
      (hit) =>
        hit.box[1] <= title.box[1] + title.box[3] ||
        hit.box[1] - title.box[1] > frame.height * 0.5 ||
        Math.abs(hit.box[0] - title.box[0]) > frame.width * 0.2,
    )
  )
    return undefined;
  return { roleId: role.value, serverName: server.value };
}

/** Worker-only: every frame comes from observe(), never last-screen or a caller image. */
export async function inspectOnmyojiIdentity(
  ports: OnmyojiIdentityPorts,
): Promise<OnmyojiIdentityEvidence> {
  ports.signal.throwIfAborted();
  const now = ports.now ?? Date.now;
  if (!ports.identity) return unconfiguredOnmyojiIdentityEvidence(now());
  const expected = validateOnmyojiIdentityBinding(ports.identity);
  const started = now();
  const bound = ports.connectedDevice();
  const evidence: OnmyojiIdentityEvidence = {
    version: 1,
    certification: "experimental",
    status: "unknown",
    reason: "profile-anchor-missing",
    candidateMatch: false,
    expected,
    ...(bound
      ? { device: { adbPath: bound.adbPath, address: bound.address } }
      : {}),
    startedAt: new Date(started).toISOString(),
    observedAt: new Date(started).toISOString(),
    frames: [],
  };
  if (!bound) {
    evidence.reason = "device-not-connected";
    return evidence;
  }
  const deadline = new AbortController();
  const signal = AbortSignal.any([ports.signal, deadline.signal]);
  const timer = setTimeout(() => deadline.abort(), 5000);
  const check = () => {
    signal.throwIfAborted();
    if (now() - started > 5000) throw Error("observation-timeout");
    const current = ports.connectedDevice();
    if (
      current?.adbPath !== evidence.device!.adbPath ||
      current?.address !== evidence.device!.address
    )
      throw Error("device-changed");
  };
  const sample = async () => {
    check();
    const packages = await ports.device.packages(signal);
    check();
    if (packages.filter((name) => name === "com.netease.onmyoji").length !== 1)
      throw Error("package-unavailable");
    if (!(await ports.appProcessRunning(bound, "com.netease.onmyoji", signal)))
      throw Error("package-not-running");
    check();
    const frame = await ports.device.observe(signal);
    check();
    evidence.packageName = "com.netease.onmyoji";
    const identity = parseOnmyojiProfileCandidate(frame);
    evidence.frames.push({
      observedAt: new Date(now()).toISOString(),
      ...(identity ? { identity } : {}),
    });
    evidence.observedAt = new Date(now()).toISOString();
    if (identity && !sameOnmyojiIdentity(identity, expected)) {
      evidence.status = "mismatch";
      evidence.reason = "identity-mismatch";
      return true;
    }
    return false;
  };
  let rejectOnAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = () => reject(signal.reason);
    signal.addEventListener("abort", rejectOnAbort, { once: true });
    if (signal.aborted) rejectOnAbort();
  });
  try {
    await Promise.race([
      (async () => {
        if (await sample()) return;
        await (
          ports.wait ?? ((ms, signal) => delay(ms, undefined, { signal }))
        )(800, signal);
        if (await sample()) return;
        const interval =
          Date.parse(evidence.frames[1].observedAt) -
          Date.parse(evidence.frames[0].observedAt);
        if (interval < 600 || interval > 1500) {
          evidence.reason = "sampling-interval";
          return;
        }
        evidence.candidateMatch = evidence.frames.every(
          (frame) =>
            frame.identity && sameOnmyojiIdentity(frame.identity, expected),
        );
        evidence.reason = evidence.candidateMatch
          ? "anchors-not-certified"
          : "profile-anchor-missing";
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
    evidence.observedAt = new Date(now()).toISOString();
  } finally {
    clearTimeout(timer);
    if (rejectOnAbort) signal.removeEventListener("abort", rejectOnAbort);
    // Pending native reads receive cancellation and can never become proof later.
    deadline.abort();
  }
  return structuredClone(evidence);
}
