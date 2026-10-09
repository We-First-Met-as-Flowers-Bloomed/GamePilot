import { AgentToolError } from "../../../packages/protocol/agent";
import type { ConfiguredSnapshot } from "../../../packages/agent/configured";
import { createAgentTools } from "../../../packages/agent/tools";
import type { ExecutionCoordinator } from "./execution-coordinator";
import type { ExecutionDetailService } from "./execution-detail";
import type { FailureEvidenceService } from "./failure-evidence-service";
import type { ContinuationService } from "./continuation-service";
import type {
  IncidentScreen,
  IncidentScreenEvidence,
  IncidentRecoveryAction,
  IncidentRecoveryVerification,
} from "../../../packages/protocol/incident-agent";
import type { PreparedIncident } from "./incident-agent";
import { gamePlugins } from "../../../games/registry";
import type { DeviceInspection } from "../../../packages/protocol/recovery";
import {
  arknightsPackage,
  validateArknightsConfig,
  type ArknightsConfig,
} from "../../../games/arknights/config";

export interface IncidentNavigationPorts {
  /** Resolve the original bound device and hold its resource lease through both observations and input. */
  withLease<T>(
    id: string,
    signal: AbortSignal,
    work: (address: string) => Promise<T>,
  ): Promise<T>;
  inspect(id: string, signal: AbortSignal): Promise<DeviceInspection>;
  returnHome(id: string, signal: AbortSignal): Promise<DeviceInspection>;
}

export class IncidentContext {
  constructor(
    private deps: {
      executions: ExecutionCoordinator;
      details: ExecutionDetailService;
      evidence: FailureEvidenceService;
      continuations: ContinuationService;
      readConfigured(): Promise<ConfiguredSnapshot>;
      /** Configuration and original target history only; unrelated lanes must not invalidate recovery. */
      readAdmissionFingerprint?(id: string): Promise<string>;
      navigation?: IncidentNavigationPorts;
      recognize(
        image: string,
        signal: AbortSignal,
        gameId: string,
      ): Promise<IncidentScreen>;
    },
  ) {}
  async fingerprint(id: string): Promise<string> {
    return this.deps.readAdmissionFingerprint
      ? this.deps.readAdmissionFingerprint(id)
      : (await this.deps.readConfigured()).fingerprint;
  }
  async recover(
    id: string,
    action: IncidentRecoveryAction,
    signal: AbortSignal,
  ): Promise<IncidentRecoveryVerification> {
    signal.throwIfAborted();
    if (!this.deps.navigation)
      throw new AgentToolError("RECOVERY_UNAVAILABLE", "原设备受限导航未接入");
    const prepared = await this.prepare(id, signal);
    if (
      !action ||
      Object.keys(action).some(
        (key) => !["kind", "gameId", "runId", "fromPage"].includes(key),
      ) ||
      prepared.manualReason ||
      !prepared.recovery ||
      prepared.recovery.kind !== action.kind ||
      prepared.recovery.gameId !== action.gameId ||
      prepared.recovery.runId !== action.runId ||
      prepared.recovery.fromPage !== action.fromPage ||
      !prepared.preview.canContinue ||
      prepared.preview.reasons.length ||
      prepared.preview.successorId
    )
      throw new AgentToolError(
        "RECOVERY_CHANGED",
        "原请求、剩余项或恢复提案已变化，不能执行旧导航",
      );
    const request = this.deps.executions.get(id),
      raw = request.snapshot.arknightsPlan
        ? request.snapshot.profile
        : request.snapshot.arknights;
    const {
      id: _profileId,
      name: _profileName,
      ...settings
    } = (raw ?? {}) as Record<string, unknown>;
    let config: ArknightsConfig;
    try {
      config = validateArknightsConfig(settings);
      if (!config.expectedUid) throw Error("unbound");
    } catch {
      throw new AgentToolError(
        "RECOVERY_UNVERIFIED",
        "原客户端与身份绑定缺失，不能导航",
      );
    }
    const assertAdmission = async () => {
      signal.throwIfAborted();
      const preview = await this.deps.continuations.preview(id);
      if (
        !preview.canContinue ||
        preview.reasons.length ||
        preview.successorId ||
        preview.fingerprint !== prepared.preview.fingerprint ||
        (await this.fingerprint(id)) !== prepared.fingerprint
      )
        throw new AgentToolError(
          "RECOVERY_CHANGED",
          "现场恢复前原设备、身份、游戏日或记录已变化",
        );
      signal.throwIfAborted();
    };
    return this.deps.navigation.withLease(id, signal, async (address) => {
      await assertAdmission();
      const beforeStarted = Date.now(),
        before = await this.deps.navigation!.inspect(id, signal);
      signal.throwIfAborted();
      this.verifyNavigationCapture(before, address, config, beforeStarted);
      if (
        before.arknights!.page !== action.fromPage &&
        before.arknights!.page !== "home"
      )
        throw new AgentToolError(
          "RECOVERY_UNVERIFIED",
          "当前页面与受限恢复提案不符，不发送返回输入",
        );
      await assertAdmission();
      const navigationStarted = Date.now(),
        after = await this.deps.navigation!.returnHome(id, signal);
      signal.throwIfAborted();
      this.verifyNavigationCapture(after, address, config, navigationStarted);
      if (after.arknights!.page !== "home")
        throw new AgentToolError(
          "RECOVERY_UNVERIFIED",
          "受限导航尚未确认主页，不提交剩余任务",
        );
      await assertAdmission();
      return {
        verified: true,
        observedAt: after.observedAt,
        evidenceRefs: [
          `${action.runId}:navigation-before`,
          `${action.runId}:navigation-after`,
        ],
      };
    });
  }
  private verifyNavigationCapture(
    capture: DeviceInspection,
    address: string,
    config: ArknightsConfig,
    started: number,
  ) {
    const at = Date.parse(capture.observedAt),
      now = Date.now(),
      scene = capture.arknights;
    if (
      !address ||
      capture.address !== address ||
      capture.foregroundPackage !== arknightsPackage(config) ||
      capture.recognitionError ||
      !Number.isFinite(at) ||
      at < started ||
      at > now ||
      now - at > 15000 ||
      !capture.pageVerified ||
      !scene?.pageVerified ||
      scene.expectedUid !== config.expectedUid ||
      ["mismatch", "unbound"].includes(scene.account) ||
      !["home", "profile", "friends-list", "credit-shop"].includes(
        scene.page,
      ) ||
      scene.frames.length !== 2 ||
      scene.frames.some(
        (f) =>
          f.page !== scene.page ||
          (f.uid !== undefined && f.uid !== config.expectedUid),
      ) ||
      (scene.page === "profile" &&
        scene.frames.some((f) => f.uid !== config.expectedUid))
    )
      throw new AgentToolError(
        "RECOVERY_UNVERIFIED",
        "导航观察不新鲜或设备、客户端、身份、双帧页面不符，不确认恢复",
      );
  }
  async prepare(id: string, signal: AbortSignal): Promise<PreparedIncident> {
    const detail = this.deps.details.get(id),
      request = this.deps.executions.get(id);
    if (
      !["failed", "unknown"].includes(request.status) ||
      request.resolution ||
      detail.games.some((g) => g.plan.mode !== "live")
    )
      throw new AgentToolError(
        "INCIDENT_TARGET_INVALID",
        "只诊断已结束且未处置的真实失败请求；取消或演练不自动恢复",
      );
    const configured = await this.deps.readConfigured(),
      fingerprint = this.deps.readAdmissionFingerprint
        ? await this.deps.readAdmissionFingerprint(id)
        : configured.fingerprint,
      alias = configured.bindings?.find((b) => b.requestId === id)?.alias;
    if (!alias)
      throw new AgentToolError(
        "INCIDENT_UNASSOCIATED",
        "无法将原请求可靠关联到当前账号，不能发送错误账号证据",
      );
    const tools = createAgentTools(configured.snapshot);
    const incident = tools.call("get_incident", {
      requestId: alias,
      environmentRevision: tools.call("get_environment").revision,
    });
    const screens: IncidentScreenEvidence[] = [];
    for (const item of (await this.deps.evidence.list(id)).slice(0, 8)) {
      signal.throwIfAborted();
      let page: IncidentScreen = "unavailable";
      try {
        const view = await this.deps.evidence.read({
          requestId: id,
          runId: item.runId,
        });
        page =
          view.status === "available"
            ? await this.deps.recognize(view.image, signal, item.gameId)
            : view.status === "missing"
              ? "missing"
              : "unavailable";
      } catch {
        signal.throwIfAborted();
      }
      screens.push({
        id: `screen-${screens.length + 1}`,
        runId: item.runId,
        gameId: item.gameId,
        observedAt: item.observedAt,
        page,
        imageSent: false,
      });
    }
    const preview = await this.deps.continuations.preview(id);
    let attempts = 0,
      cursor = request;
    const visited = new Set<string>();
    while (cursor.snapshot.continuation) {
      if (visited.has(cursor.id) || ++attempts > 32) {
        attempts = 2;
        break;
      }
      visited.add(cursor.id);
      const parent = (cursor.snapshot.continuation as { parentId: string })
        .parentId;
      try {
        cursor = this.deps.executions.get(parent);
      } catch {
        attempts = 2;
        break;
      }
    }
    const failed = detail.games
      .map((g) => g.record)
      .filter((t) => t?.fault && t.status === "failed");
    let manualReason: string | undefined;
    if (screens.some((screen) => screen.page === "client-update-required")) {
      manualReason =
        "失败截图显示明日方舟客户端版本过时，请先更新对应客户端；更新后仍需重新核对原请求，未知结果不会自动重做。";
      preview.reasons.push(manualReason);
      preview.canContinue = false;
    }
    if (attempts >= 2)
      manualReason ??=
        "原请求续跑链已达两次恢复预算，必须人工核对，不自动重置预算。";
    if (
      screens.some((s) =>
        [
          "sdk-login",
          "phone-login",
          "verification-code",
          "identity-input",
          "payment",
          "unknown-confirmation",
        ].includes(s.page),
      )
    )
      manualReason ??=
        "身份、支付或未识别确认弹窗必须由你处理并重新核对现场，不发送确认输入。";
    const blockers = detail.games.flatMap((g) =>
      g.record
        ? gamePlugins.get(g.plan.gameId).recovery.replayBlockers(g.record)
        : [],
    );
    if (blockers.length) {
      manualReason ??= blockers.join("；");
      preview.reasons.push(...blockers);
      preview.canContinue = false;
    }
    const retained = detail.games.flatMap(
      (g) =>
        g.record?.steps
          .filter((step) =>
            gamePlugins.get(g.plan.gameId).recovery.retainedStep(step),
          )
          .map((step) => ({ gameId: g.plan.gameId, skillId: step.skillId })) ??
        [],
    );
    for (const item of retained) {
      const step = preview.steps.find(
        (s) => s.gameId === item.gameId && s.skillId === item.skillId,
      );
      if (step) {
        step.status = "excluded";
        step.message =
          item.gameId === "onmyoji"
            ? "已确认业务效果；返回未完成，不重复领取或提交，原失败保留"
            : "原生购物及余额已核对；只允许导航恢复，不重复购买，原失败保留";
      }
    }
    preview.defaults = preview.defaults
      .map((g) => ({
        ...g,
        skillIds: g.skillIds.filter(
          (id) =>
            !retained.some(
              (item) => item.gameId === g.gameId && item.skillId === id,
            ),
        ),
      }))
      .filter((g) => g.skillIds.length);
    if (!preview.defaults.length) {
      preview.canContinue = false;
      preview.reasons.push("没有可重新提交的业务剩余项；已确认效果不会重做");
    }
    if (failed.some((task) => task?.gameId === "onmyoji"))
      manualReason ??=
        "阴阳师当前角色身份尚未独立核验；保留已确认效果，不开放自动业务重放。";
    const recovery =
      !manualReason && failed.length === 1
        ? gamePlugins
            .get(failed[0]!.gameId)
            .recovery.propose(
              failed[0]!,
              screens.find((s) => s.runId === failed[0]!.runId)?.page ??
                "unavailable",
              attempts,
            )
        : undefined;
    const automaticAllowed =
      !manualReason &&
      incident.run.complete &&
      detail.warnings.length === 0 &&
      failed.length === 1 &&
      gamePlugins
        .get(failed[0]!.gameId)
        .recovery.allowRetry(
          failed[0]!,
          screens.find((s) => s.runId === failed[0]!.runId)?.page ??
            "unavailable",
          attempts,
        );
    if (
      this.deps.readAdmissionFingerprint &&
      (await this.fingerprint(id)) !== fingerprint
    )
      throw new AgentToolError(
        "RECOVERY_CHANGED",
        "读取证据时原设备或配置已变化，请重新诊断",
      );
    signal.throwIfAborted();
    return {
      fingerprint,
      preview,
      screens,
      automaticAllowed,
      ...(manualReason ? { manualReason } : {}),
      ...(recovery ? { recovery } : {}),
      bundle: {
        incident,
        screens: screens.map((s, i) => ({
          ...s,
          runId: `screen-run-${i + 1}`,
        })),
      },
    };
  }
}
