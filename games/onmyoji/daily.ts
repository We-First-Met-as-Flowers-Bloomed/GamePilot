import { setTimeout as delay } from "node:timers/promises";
import type {
  Frame,
  GameDevice,
  Rect,
  TextHit,
} from "../../packages/runtime/device";
import type { SkillResult } from "../../packages/protocol";
import { waitForStableFrame } from "./stability";
import { sameFosterPage, type FosterRow } from "./foster-list";
import { TaskFaultError } from "../../packages/protocol/fault";
import { fosterRemainingSeconds, fosterScheduleResult } from "./foster-time";
import {
  hasCentralLoginPrompt,
  isEngineUpdateLoginBackground,
  loginEngineUpdate,
  unsafeLoginUpdateFrame,
} from "./login-update";
import type {
  OnmyojiEffect,
  OnmyojiExecutionEvidence,
} from "../../packages/protocol/onmyoji-evidence";
import {
  bossName,
  findText,
  gameDay,
  hasOneKeyChores,
  courtyardTasksDailyTabPoint,
  hasMailOneKeyClaim,
  dailyGiftAction,
  hasPricedDailyGiftEntry,
  isChoreClaimResult,
  isChoreComplete,
  isCourtyard,
  isCourtyardTasks,
  isCourtyardReward,
  isDailyGiftList,
  isDailyGiftDetail,
  isDailyGiftReward,
  dailySignClosePoint,
  choreClaimClosePoint,
  dailyGiftTabPoint,
  restoreBuffCancel,
  centralConfirmation,
  fullTrainingExtractionCancel,
  isDetail,
  isExploration,
  isGiftHouse,
  isGuild,
  isGuildRealm,
  isGuildKirinWindow,
  isCollectiveTaskPage,
  collectiveTaskTarget,
  collectiveClaimAction,
  collectiveSubmitAction,
  collectiveProgress,
  isHanaPage,
  hanaPromotionClosePoint,
  isShikigamiDispatch,
  isFriendPage,
  promoInvitationClosePoint,
  quitGameCancelPoint,
  hanaClaimAction,
  hanaTaskState,
  isHanaTaskPage,
  isHanaReward,
  fosterNames,
  fosterCardKind,
  chooseFosterCandidate,
  isFosterFriendList,
  isTrainingPage,
  ownTrainingEntry,
  isRealmSignsPage,
  isFriendRealm,
  isFosterActive,
  isKirinHunt,
  isKirinVictory,
  isMailbox,
  isMailClaimConfirm,
  isMailReward,
  isIllustrationReward,
  isMap,
  isShop,
  isShopDistrict,
  isShrine,
  isVictory,
  oborogurumaAutoEquipDialog,
  oborogurumaBuffButton,
  oborogurumaBuffChip,
  oborogurumaBuffRow,
  isOborogurumaBuffPanel,
  oborogurumaCount,
  oborogurumaDepart,
  oborogurumaNextStep,
  oborogurumaSettlement,
  oborogurumaSettlementConfirm,
  isOborogurumaCard,
  isOborogurumaActivity,
  oborogurumaTitle,
  personalScore,
  quotaFor,
  signInRewardClosePoint,
  isMakaiHourPage,
} from "./policy";
type NamedFosterCandidate = {
  name: string;
  kind: "taiko" | "douyu";
  stars: number;
  page: number;
  row: number;
};
type Pause = (ms: number, signal: AbortSignal) => Promise<void>;
export class OnmyojiDaily {
  private effectEvidence?: OnmyojiExecutionEvidence;
  constructor(
    private device: GameDevice,
    private log: (message: string, result?: SkillResult) => void,
    private pause: Pause = (ms, signal) => delay(ms, undefined, { signal }),
    private now: () => Date = () => new Date(),
  ) {}
  private beginEffects(skillId: OnmyojiExecutionEvidence["skillId"]) {
    this.effectEvidence = {
      version: 1,
      skillId,
      phase: "not-submitted",
      observedAt: this.now().toISOString(),
      effects: [],
    };
    this.persistEffects("业务输入尚未提交；结果不能由页面推断");
  }
  private persistEffects(message: string) {
    if (!this.effectEvidence) throw Error("缺少阴阳师效果记录上下文");
    this.effectEvidence.observedAt = this.now().toISOString();
    this.log(message, { onmyoji: structuredClone(this.effectEvidence) });
  }
  private submittingEffect() {
    this.effectEvidence!.phase = "submitted";
    this.persistEffects("即将发送业务输入；提交或效果未确认时禁止重放");
  }
  private confirmedEffect(kind: OnmyojiEffect["kind"], summary: string) {
    const evidence = this.effectEvidence!;
    evidence.effects.push({
      kind,
      summary,
      observedAt: this.now().toISOString(),
      evidenceReference: `onmyoji:${evidence.skillId}:effect:${evidence.effects.length + 1}`,
    });
    // Existing completed/empty markers can establish effects without sending a claim.
    if (evidence.phase === "not-submitted") evidence.phase = "confirmed";
    this.persistEffects(summary);
  }
  private completedEffects() {
    this.effectEvidence!.phase = "confirmed";
    this.persistEffects(
      `${this.effectEvidence!.effects.at(-1)!.summary}；后续返回仍需验证，原流程尚未完成`,
    );
  }
  private recordedEffects(): { onmyoji: OnmyojiExecutionEvidence } {
    return { onmyoji: structuredClone(this.effectEvidence!) };
  }
  private async shot(signal: AbortSignal) {
    signal.throwIfAborted();
    let f = await this.device.observe(signal);
    const bountyInvitation = (frame: Frame) =>
      findText(frame, /^悬赏封印$/, [800, 200, 400, 120]) &&
      findText(frame, /^接受$/, [1350, 560, 200, 130]) &&
      findText(frame, /^拒绝$/, [1350, 720, 200, 130]);
    let promotionDismissals = 0;
    let invitationDismissals = 0;
    let quitDismissals = 0;
    for (let attempt = 0; ; attempt++) {
      const invitation = bountyInvitation(f);
      const cancelExtraction = fullTrainingExtractionCancel(f);
      const promotionClose = hanaPromotionClosePoint(f);
      const promoInvitation = promoInvitationClosePoint(f);
      const quitCancel = quitGameCancelPoint(f);
      if (
        !invitation &&
        !cancelExtraction &&
        !promotionClose &&
        !promoInvitation &&
        !quitCancel
      )
        break;
      // 退出确认框最优先：它在最上层，别的判断都可能被它挡着。
      if (quitCancel && quitDismissals >= 1)
        throw Error("退出游戏确认框取消后仍未消失，已停止当前操作");
      if (promotionClose && promotionDismissals >= 2)
        throw Error("花合战宣传页两次关闭后仍未消失，已停止当前操作");
      if (promoInvitation && invitationDismissals >= 1)
        throw Error("过期活动邀请函关闭后仍未消失，已停止当前操作");
      if (attempt >= 3)
        throw Error(
          invitation
            ? "悬赏邀请未能关闭，停止当前操作"
            : "满级式神提取提示未能关闭，停止当前操作",
        );
      if (quitCancel) {
        await this.tap(...quitCancel, signal);
        quitDismissals++;
      } else if (promotionClose) {
        await this.tap(...promotionClose, signal);
        promotionDismissals++;
      } else if (promoInvitation) {
        await this.tap(...promoInvitation, signal);
        invitationDismissals++;
      } else if (invitation) await this.tap(1175, 180, signal);
      else await this.text(cancelExtraction!, signal);
      this.log(
        quitCancel
          ? "已取消「退出游戏」确认框（只点取消），继续原任务"
          : promotionClose
            ? "已按花合战宣传页提示点击空白处，重新核对当前页面"
            : promoInvitation
              ? "已关闭过期活动邀请函，继续原任务"
              : invitation
                ? "已关闭悬赏邀请，继续原任务"
                : "已取消满级式神提取提示，保留结界式神并继续原任务",
      );
      f = await this.device.observe(signal);
    }
    if (findText(f, /是否继续刚才的战斗/, [600, 300, 750, 400]))
      throw new Error("检测到未结束的战斗，请先在模拟器处理恢复提示后重试");
    return f;
  }

  private courtyardPopup(frame: Frame) {
    const cancelBuff = restoreBuffCancel(frame);
    if (cancelBuff)
      return {
        point: [
          cancelBuff.box[0] + cancelBuff.box[2] / 2,
          cancelBuff.box[1] + cancelBuff.box[3] / 2,
        ] as [number, number],
        message: "已取消恢复加成提示，保留原有关闭状态",
      };
    if (centralConfirmation(frame)) return undefined;
    const signClose = dailySignClosePoint(frame);
    if (signClose)
      return { point: signClose, message: "已关闭签到卷轴，继续核对当前页面" };
    if (isChoreClaimResult(frame))
      return {
        point: choreClaimClosePoint(frame) ?? ([960, 1030] as [number, number]),
        message: "已关闭庭院奖励，继续核对当前页面",
      };
    if (isCourtyardReward(frame))
      return {
        point: [960, 1030] as [number, number],
        message: "已关闭庭院奖励，继续核对当前页面",
      };
    return undefined;
  }

  private rejectUnknownConfirmation(frame: Frame) {
    if (centralConfirmation(frame))
      throw Error("检测到未识别的确认弹窗，已停止且未点击确认，请查看设备画面");
  }

  private async loginPage(
    first: Frame,
    signal: AbortSignal,
    budget: { engineUpdates: number },
  ): Promise<Frame> {
    let frame = first;
    const attemptsByLayer = new Map<string, number>();
    const layer = (f: Frame) => {
      const p = this.courtyardPopup(f);
      return p
        ? `${p.point[0]},${p.point[1]}`
        : isMailbox(f) && !isMailClaimConfirm(f)
          ? "mailbox"
          : undefined;
    };
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      const update = loginEngineUpdate(frame);
      if (update.kind === "blocked")
        throw Error("引擎更新提示无法可靠核对，已停止且未点击更新或下载");
      if (update.kind === "optional") {
        if (budget.engineUpdates >= 2)
          throw Error("已两次选择暂不更新，引擎更新提示仍出现，停止登录");
        await this.text(update.skip, signal);
        budget.engineUpdates++;
        this.log("已发送暂不更新，等待可选引擎更新提示消失");
        for (let poll = 0; poll < 4; poll++) {
          frame = await this.shot(signal);
          const observedUpdate = loginEngineUpdate(frame);
          if (
            unsafeLoginUpdateFrame(frame) ||
            observedUpdate.kind === "blocked" ||
            (observedUpdate.kind === "absent" && hasCentralLoginPrompt(frame))
          )
            throw Error("关闭可选引擎更新后的页面无法可靠核对，停止登录");
          const remaining = observedUpdate.kind === "optional";
          if (
            !remaining &&
            (isEngineUpdateLoginBackground(frame) || isCourtyard(frame))
          ) {
            this.log("已核对可选引擎更新提示消失，继续原登录");
            break;
          }
          if (poll === 3 && !remaining)
            throw Error("关闭可选引擎更新后的页面未确认，停止登录");
          if (poll < 3) await this.pause(600, signal);
        }
        continue;
      }
      const popup = this.courtyardPopup(frame);
      if (!popup) this.rejectUnknownConfirmation(frame);
      const settledRealm = (f: Frame) => {
        if (
          f.width !== 1920 ||
          f.height !== 1080 ||
          !findText(f, /点击屏幕继续/, [550, 980, 900, 100])
        )
          return;
        if (isVictory(f)) return "realm-victory";
        if (
          findText(f, /^通关时间\s*\d{2}[:：]\d{2}$/, [200, 780, 500, 100]) &&
          findText(f, /^\d{1,8}$/, [280, 250, 500, 250])
        )
          return "realm-reward";
      };
      const settlement = settledRealm(frame);
      if (!popup && settlement) {
        if (attemptsByLayer.has(settlement))
          throw Error("此前战斗结算仍未关闭，停止登录");
        const verified = await this.shot(signal);
        this.rejectUnknownConfirmation(verified);
        if (settledRealm(verified) !== settlement)
          throw Error("此前战斗结算双帧不一致，停止登录");
        attemptsByLayer.set(settlement, 1);
        await this.tap(960, 1030, signal);
        this.log(
          "登录时已关闭此前战斗的胜利结算；不发起新战斗，不据此补写日常完成",
        );
        for (let poll = 0; poll < 4; poll++) {
          frame = await this.shot(signal);
          this.rejectUnknownConfirmation(frame);
          if (settledRealm(frame) !== settlement) break;
          if (poll < 3) await this.pause(600, signal);
        }
        if (settledRealm(frame) === settlement)
          throw Error("此前战斗结算仍未关闭，停止登录");
        continue;
      }
      if (isMailReward(frame) || isIllustrationReward(frame)) {
        await this.closeMailRewards(frame, signal);
        return this.courtyard(signal);
      }
      if (
        !popup &&
        (isShop(frame) ||
          isGiftHouse(frame) ||
          isDailyGiftList(frame) ||
          isShopDistrict(frame))
      ) {
        // A continuation can start on the shop left by its failed predecessor.
        // Return through existing navigation, then let login verify courtyard.
        if (
          findText(
            frame,
            /密码|验证码|实名认证|扫码登录/,
            [300, 150, 1320, 750],
          )
        )
          throw new Error("登录需要本人处理，请在模拟器完成登录后重新执行");
        this.log("登录时已识别商店页面，返回庭院后重新核对登录状态");
        return this.courtyard(signal);
      }
      const mailbox = isMailbox(frame) && !isMailClaimConfirm(frame);
      if (!popup && !mailbox) return frame;
      const currentLayer = layer(frame)!;
      const layerAttempts = attemptsByLayer.get(currentLayer) ?? 0;
      if (attempt >= 8 || layerAttempts >= 3)
        throw Error("登录弹层未能关闭，已停止当前操作");
      attemptsByLayer.set(currentLayer, layerAttempts + 1);
      if (popup) {
        await this.tap(...popup.point, signal);
        this.log("已发送已识别弹层的关闭操作，等待画面确认");
      } else await this.tap(1765, 185, signal, 1500);
      // Animation latency must not spend the next layer's navigation budget.
      // Observe freshly after input, and never retry using the preceding frame.
      for (let poll = 0; poll < 4; poll++) {
        frame = await this.shot(signal);
        if (!this.courtyardPopup(frame)) this.rejectUnknownConfirmation(frame);
        if (layer(frame) !== currentLayer) {
          if (popup) this.log(popup.message);
          break;
        }
        if (poll < 3) await this.pause(600, signal);
      }
    }
  }
  private async tap(x: number, y: number, signal: AbortSignal, wait = 1100) {
    signal.throwIfAborted();
    await this.device.click(x, y, signal);
    await this.pause(wait, signal);
  }
  private async text(hit: TextHit, signal: AbortSignal) {
    await this.tap(
      hit.box[0] + hit.box[2] / 2,
      hit.box[1] + hit.box[3] / 2,
      signal,
    );
  }
  /** 下一步金色齿轮按钮：美术字 OCR 常缺失，用模板匹配兜底（卡片右下区域）。 */
  private async cardNextStep(f: Frame, signal: AbortSignal) {
    const hit = oborogurumaNextStep(f);
    if (hit) return hit;
    return (
      (await this.device.matchTemplate(
        "oboroguruma-next.png",
        [1380, 760, 540, 320],
        0.8,
        signal,
      )) ?? undefined
    );
  }
  private async waitFor(
    predicate: (f: Frame) => boolean,
    signal: AbortSignal,
    attempts = 8,
  ): Promise<Frame> {
    for (let i = 0; i < attempts; i++) {
      const f = await this.shot(signal);
      if (predicate(f)) return f;
      await this.pause(1200, signal);
    }
    throw new Error("画面未进入预期状态，已停止；请查看设备画面及运行记录");
  }
  async login(signal: AbortSignal): Promise<SkillResult> {
    const budget = { engineUpdates: 0 };
    let f = await this.loginPage(await this.shot(signal), signal, budget);
    // 2026-10-14 更新后游戏可能停在「寮境」子页面：它不是庭院，也不会自己返回，
    // 先有界退回上一层再核对登录态。
    for (let escape = 0; escape < 3 && isGuildRealm(f); escape++) {
      this.log("已识别寮境页面，返回上一层后重新核对登录状态");
      await this.tap(75, 60, signal, 1500);
      f = await this.loginPage(await this.shot(signal), signal, budget);
    }
    const disconnected = (frame: Frame) =>
      !!findText(frame, /已断开游戏服务器.*需要重新连接/, [600, 380, 720, 220]);
    const loggedIn = (frame: Frame) =>
      !disconnected(frame) &&
      (isCourtyard(frame) ||
        hasOneKeyChores(frame) ||
        isExploration(frame) ||
        isMap(frame) ||
        isDetail(frame) ||
        isGuild(frame) ||
        isTrainingPage(frame) ||
        isOborogurumaActivity(frame) ||
        // 2026-10-15：游戏停在式神委派页时，白名单里没有它 → 判定"没进游戏" → 重启游戏
        // → 启动等待超时 → 整条日常报废。把技能与人都可能停留的游戏内页面补进白名单。
        isShikigamiDispatch(frame) ||
        isFriendPage(frame) ||
        isHanaPage(frame) ||
        isShop(frame) ||
        isGiftHouse(frame) ||
        isMailbox(frame));
    if (loggedIn(f)) {
      await this.pause(600, signal);
      f = await this.loginPage(await this.shot(signal), signal, budget);
      if (loggedIn(f)) {
        this.log("已确认游戏内登录状态");
        return {
          status: "succeeded",
          goalSatisfied: true,
          evidenceTimestamp: this.now().toISOString(),
          evidenceReference: "onmyoji:login:two-frames",
          summary: "已用两帧核对现有游戏登录态；角色身份未作独立核验",
        };
      }
    }
    if (findText(f, /密码|验证码|实名认证|扫码登录/, [300, 150, 1320, 750]))
      throw new Error("登录需要本人处理，请在模拟器完成登录后重新执行");
    const installed = (await this.device.packages(signal)).filter((p) =>
      p.startsWith("com.netease.onmyoji"),
    );
    if (installed.length !== 1)
      throw new Error("未找到唯一的阴阳师客户端，请只保留要运行的渠道客户端");
    const coldStart = !(await this.device.isAppRunning(installed[0], signal));
    this.log("启动阴阳师，等待已有登录态进入游戏");
    await this.device.startApp(installed[0], signal);
    let entryClicks = 0;
    let introTaps = 0;
    let reconnects = 0;
    for (let i = 0; i < 60; i++) {
      await this.pause(2000, signal);
      f = await this.loginPage(await this.shot(signal), signal, budget);
      if (disconnected(f)) {
        if (reconnects >= 2) throw Error("已重连两次仍断开服务器，停止上号");
        const confirm = findText(f, /^确定$/, [800, 540, 330, 140]);
        if (!confirm) throw Error("断线提示缺少确认按钮，停止上号");
        await this.text(confirm, signal);
        reconnects++;
        this.log(`已确认登录阶段断线，重新连接 ${reconnects}/2`);
        continue;
      }
      if (isGuildRealm(f)) {
        this.log("已识别寮境页面，返回上一层后重新核对登录状态");
        await this.tap(75, 60, signal, 1500);
        continue;
      }
      if (loggedIn(f)) {
        await this.pause(600, signal);
        const verified = await this.loginPage(
          await this.shot(signal),
          signal,
          budget,
        );
        if (loggedIn(verified)) {
          this.log("已确认进入游戏");
          return {
            status: "succeeded",
            goalSatisfied: true,
            evidenceTimestamp: this.now().toISOString(),
            evidenceReference: "onmyoji:login:two-frames",
            summary: "已用两帧核对进入游戏；角色身份未作独立核验",
          };
        }
        continue;
      }
      if (findText(f, /密码|验证码|实名认证|扫码登录/, [300, 150, 1320, 750]))
        throw new Error("登录态需要本人处理，请完成后重新执行");
      // Only a process we started cold may receive a cinematic-dismiss tap.
      // A running game's unknown screen never takes this branch.
      if (
        coldStart &&
        introTaps < 3 &&
        i >= 2 &&
        i % 3 === 2 &&
        f.texts.length > 0 &&
        f.texts.length <= 3 &&
        f.texts.every((h) => h.box[1] >= 850)
      ) {
        await this.tap(960, 540, signal);
        introTaps++;
        this.log("关闭启动动画，等待登录界面");
        continue;
      }
      const enter = findText(f, /^(进入游戏|开始游戏|点击(?:屏幕)?进入游戏)$/);
      if (enter && entryClicks < 3) {
        await this.text(enter, signal);
        entryClicks++;
        this.log("进入当前已选择的服务器与角色");
      }
    }
    throw new Error("启动等待超时；请处理游戏更新、公告或登录弹窗后再试");
  }
  private async courtyard(signal: AbortSignal): Promise<Frame> {
    for (let attempt = 0; attempt < 15; attempt++) {
      const frame = await this.shot(signal);
      const popup = this.courtyardPopup(frame);
      if (!popup) this.rejectUnknownConfirmation(frame);
      if (isMailReward(frame) || isIllustrationReward(frame)) {
        await this.closeMailRewards(frame, signal);
        continue;
      }
      if (popup) {
        await this.tap(...popup.point, signal);
        this.log(popup.message);
        continue;
      }
      if (
        isCollectiveTaskPage(frame) &&
        findText(frame, /^获得奖励$/, [500, 100, 900, 500])
      ) {
        await this.tap(1700, 900, signal, 1500);
        continue;
      }
      if (isCourtyard(frame)) return frame;
      if (isGuildRealm(frame)) {
        this.log("已识别寮境页面，返回上一层后重新核对庭院");
        await this.tap(75, 60, signal, 1500);
        continue;
      }
      // 2026-10-16：逢魔之时页也要能退出来。它是全屏地图页，`courtyard()` 原来没有
      // 这一页的退路 → 一旦（技能或人的点击）进到这里就永远回不到庭院，
      // 整条阴阳师日常报「进入庭院检查每日签到失败」。退路与其它页面一致：左上角返回。
      if (isMakaiHourPage(frame)) {
        this.log("已识别逢魔之时页面，返回上一层后重新核对庭院");
        await this.tap(75, 60, signal, 1500);
        continue;
      }
      // 2026-10-16：签到奖励「领取成功」弹窗会盖住庭院 → courtyard() 认不出庭院 →
      // 整条阴阳师日常报"进入庭院检查每日签到失败"，而奖励其实**已经发放**（现场帧为证）。
      // 三处稳定元素齐全才认，只点右上角 ✕，绝不点空白或奖励区。
      const signInReward = signInRewardClosePoint(frame);
      if (signInReward) {
        this.log("已识别「领取成功」签到奖励弹窗，仅点击右上角关闭");
        await this.tap(signInReward[0], signInReward[1], signal, 1500);
        continue;
      }
      // 2026-10-15：技能与人都可能把游戏停在别的游戏内页面；不认这些页面就会
      // 「进入地域鬼王失败」——因为回不去庭院，后面每一步都无从开始。
      if (isShikigamiDispatch(frame)) {
        this.log("已识别式神委派页面，返回上一层后重新核对庭院");
        await this.tap(60, 55, signal, 1500);
        continue;
      }
      if (isFriendPage(frame)) {
        this.log("已识别好友页面，关闭后重新核对庭院");
        await this.tap(1780, 177, signal, 1500);
        continue;
      }
      if (isDetail(frame)) {
        await this.tap(1812, 60, signal);
        continue;
      }
      if (isMap(frame) || isExploration(frame)) {
        await this.tap(75, 60, signal, 1500);
        continue;
      }
      if (isMailbox(frame)) {
        await this.tap(1765, 185, signal, 1500);
        continue;
      }
      if (isCollectiveTaskPage(frame)) {
        await this.tap(1755, 180, signal, 1200);
        continue;
      }
      if (isHanaPage(frame) || isCourtyardTasks(frame)) {
        await this.tap(75, 60, signal, 1200);
        continue;
      }
      if (
        isFosterFriendList(frame) ||
        ownTrainingEntry(frame) !== null ||
        // 2026-10-15 lane-b：中牌「式神育成」读不出时，靠左右两块牌子也能认出结界页，
        // 否则既认不出页面、也回不去庭院，寄养第一步就失败。
        isRealmSignsPage(frame) ||
        isTrainingPage(frame) ||
        isFriendRealm(frame) ||
        isFosterActive(frame)
      ) {
        await this.tap(60, 60, signal, 1100);
        continue;
      }
      if (
        isShop(frame) ||
        isGiftHouse(frame) ||
        isDailyGiftList(frame) ||
        isShopDistrict(frame)
      ) {
        await this.tap(75, 60, signal, 1500);
        continue;
      }
      if (isGuild(frame) || isShrine(frame)) {
        await this.tap(75, 60, signal, 1500);
        continue;
      }
      if (isKirinHunt(frame)) {
        await this.tap(65, 60, signal, 1500);
        continue;
      }
      if (
        findText(frame, /^狩猎战$/, [120, 0, 400, 150]) &&
        findText(frame, /^挑战$/, [1580, 800, 340, 260])
      ) {
        await this.tap(65, 60, signal, 1500);
        continue;
      }
      // Some courtyard skins can enter a scenery view that hides every text
      // anchor. Require both fixed controls before using its back button.
      const sceneBack = await this.device.matchTemplate(
        "courtyard-scene-back.png",
        [20, 20, 140, 130],
        0.85,
        signal,
      );
      const sceneMusic = sceneBack
        ? await this.device.matchTemplate(
            "courtyard-scene-music.png",
            [1680, 860, 240, 220],
            0.85,
            signal,
          )
        : null;
      if (sceneBack && sceneMusic) {
        await this.tap(
          sceneBack.box[0] + sceneBack.box[2] / 2,
          sceneBack.box[1] + sceneBack.box[3] / 2,
          signal,
          1500,
        );
        continue;
      }
      await this.pause(1200, signal);
    }
    throw new Error("进入庭院检查每日签到失败");
  }
  async checkIn(signal: AbortSignal): Promise<SkillResult> {
    this.beginEffects("check-in");
    await this.courtyard(signal);
    let pending = await this.device.matchTemplate(
      "courtyard-tasks.png",
      [1180, 420, 500, 360],
      0.78,
      signal,
    );
    pending ??=
      (await this.device.matchFeatures?.(
        "courtyard-tasks.png",
        [1050, 420, 650, 400],
        signal,
      )) ?? null;
    if (!pending) {
      const closedMenu = await this.device.matchTemplate(
        "courtyard-menu-closed.png",
        [1700, 700, 220, 380],
        0.78,
        signal,
      );
      if (closedMenu) {
        await this.tap(
          closedMenu.box[0] + closedMenu.box[2] / 2,
          closedMenu.box[1] + closedMenu.box[3] / 2,
          signal,
          1200,
        );
        this.log("庭院卷宗已关闭，已自动展开");
        pending = await this.device.matchTemplate(
          "courtyard-tasks.png",
          [1180, 420, 500, 360],
          0.78,
          signal,
        );
        pending ??=
          (await this.device.matchFeatures?.(
            "courtyard-tasks.png",
            [1050, 420, 650, 400],
            signal,
          )) ?? null;
      }
    }
    if (pending) {
      await this.tap(
        pending.box[0] + pending.box[2] / 2,
        pending.box[1] + pending.box[3] / 2,
        signal,
        1600,
      );
    } else {
      // On the verified purple courtyard layout the icon vanishes after chores,
      // but the paper doll remains an entry. Recheck both layout anchors before
      // this single navigation attempt; only the actual task page proves success.
      const current = await this.shot(signal);
      if (
        !isCourtyard(current) ||
        !findText(current, /^(探索|探)$/, [950, 170, 150, 200]) ||
        !findText(current, /^(召唤|召|唤)$/, [1250, 180, 500, 260])
      )
        throw new Error(
          "未找到庭院事务入口，签到状态未确认；请检查庭院皮肤和画面",
        );
      await this.tap(1170, 690, signal, 1600);
    }
    let tasks = await this.waitFor(
      (f) => isCourtyardTasks(f) || isCourtyardReward(f),
      signal,
      8,
    );
    this.rejectUnknownConfirmation(tasks);
    if (isCourtyardReward(tasks)) {
      // A paper doll can hand out its courtyard reward before opening chores.
      // Dismiss only the observed reward; the task page must still be verified.
      await this.tap(960, 1030, signal);
      const current = await this.courtyard(signal);
      if (
        !findText(current, /^(探索|探)$/, [950, 170, 150, 200]) ||
        !findText(current, /^(召唤|召|唤)$/, [1250, 180, 500, 260])
      )
        throw Error("庭院奖励已关闭，但小纸人入口布局无法确认");
      this.log("已关闭小纸人奖励，重新核对庭院事务入口");
      await this.tap(1170, 690, signal, 1600);
      tasks = await this.waitFor(isCourtyardTasks, signal, 8);
      this.rejectUnknownConfirmation(tasks);
    }
    if (!hasOneKeyChores(tasks)) {
      // The chores page remembers the last-open tab; an event tab (e.g. a
      // limited-time banner) hides the one-key button. Switch back once and
      // re-verify; the original error text still applies when neither exists.
      const dailyTab = courtyardTasksDailyTabPoint(tasks);
      if (!dailyTab)
        throw new Error("庭院事务页未显示一键完成按钮，未执行日常任务");
      this.log("庭院事务停留在其他页签，先切回日常页签");
      await this.tap(dailyTab[0], dailyTab[1], signal, 1400);
      tasks = await this.waitFor(isCourtyardTasks, signal, 8);
      this.rejectUnknownConfirmation(tasks);
    }
    if (!hasOneKeyChores(tasks))
      throw new Error("庭院事务页未显示一键完成按钮，未执行日常任务");
    this.log("已打开庭院事务，按游戏内已启用项目执行一键完成");
    this.submittingEffect();
    await this.tap(1740, 940, signal, 1400);
    let current = await this.waitFor(
      (f) =>
        isChoreClaimResult(f) ||
        dailySignClosePoint(f) !== null ||
        (isCourtyardTasks(f) && isChoreComplete(f, /^每日一签$/)),
      signal,
      10,
    );
    this.log("一键事务操作已返回，正在核对每日一签状态");
    let completed: Frame | undefined;
    for (let overlay = 0; overlay <= 4; overlay++) {
      this.rejectUnknownConfirmation(current);
      if (
        !isChoreClaimResult(current) &&
        !dailySignClosePoint(current) &&
        isCourtyardTasks(current)
      ) {
        completed = current;
        break;
      }
      if (overlay === 4) break;
      const close = choreClaimClosePoint(current) ??
        dailySignClosePoint(current) ?? [960, 1030];
      await this.tap(close[0], close[1], signal, 1000);
      for (let poll = 0; poll < 4; poll++) {
        current = await this.shot(signal);
        this.rejectUnknownConfirmation(current);
        const nextClose =
          choreClaimClosePoint(current) ?? dailySignClosePoint(current);
        if (
          !nextClose ||
          nextClose[0] !== close[0] ||
          nextClose[1] !== close[1]
        )
          break;
        if (poll < 3) await this.pause(600, signal);
      }
    }
    if (!completed)
      throw new Error("领取后未能关闭签到奖励画面，已停止后续任务");
    if (!isChoreComplete(completed, /^每日一签$/))
      throw new Error("庭院事务已领取，但未能确认每日一签已完成");
    this.confirmedEffect(
      "one-key-chores",
      "已核对每日一签完成；一键庭院事务已返回",
    );
    this.completedEffects();
    this.log("每日一签已完成，本次一键庭院事务检查结束");
    return {
      status: "succeeded",
      summary: "已确认每日一签完成，并核对庭院一键事务",
      goalSatisfied: true,
      evidenceTimestamp: this.now().toISOString(),
      evidenceReference: "onmyoji:check-in:verified-completed-row",
      ...this.recordedEffects(),
    };
  }

  private async closeMailRewards(first: Frame, signal: AbortSignal) {
    let current = first;
    let dismissals = 0;
    for (let attempt = 0; attempt < 8; attempt++) {
      signal.throwIfAborted();
      this.rejectUnknownConfirmation(current);
      // Check overlays before the mailbox, whose labels may show underneath.
      const illustration = isIllustrationReward(current);
      if (illustration || isMailReward(current)) {
        if (dismissals >= 3)
          throw Error("邮件奖励弹层未能关闭，已停止且不重复领取");
        await this.tap(960, illustration ? 1050 : 1020, signal, 1200);
        dismissals++;
        if (illustration) this.log("已关闭插画奖励，继续核对邮箱");
      } else if (isMailbox(current) && !isMailClaimConfirm(current)) {
        return current;
      } else {
        await this.pause(1200, signal);
      }
      current = await this.shot(signal);
    }
    throw Error("邮件奖励后未能确认邮箱状态，已停止且不重复领取");
  }

  async mail(signal: AbortSignal): Promise<SkillResult> {
    this.beginEffects("mail");
    await this.courtyard(signal);
    // The red dot can remain for unread text-only mail after attachments are
    // claimed, so the mailbox's one-key action is the authoritative signal.
    await this.tap(1733, 55, signal, 1400);
    const mailbox = await this.waitFor(isMailbox, signal, 8);
    if (!hasMailOneKeyClaim(mailbox)) {
      this.confirmedEffect("mail-claim", "已核对邮箱无待领取附件；未重复领取");
      this.completedEffects();
      this.log("邮箱没有待领取邮件，未操作已读或删除按钮");
      return {
        status: "skipped",
        skipReason: "nothing-to-claim",
        goalSatisfied: true,
        evidenceTimestamp: this.now().toISOString(),
        evidenceReference: "onmyoji:mail:verified-empty",
        ...this.recordedEffects(),
        summary: "已核对邮箱，无待领取附件",
      };
    }
    this.submittingEffect();
    await this.tap(160, 920, signal, 1200);
    await this.waitFor(isMailClaimConfirm, signal, 6);
    this.submittingEffect();
    await this.tap(1155, 860, signal, 1200);
    const reward = await this.waitFor(
      (f) => isMailReward(f) || isIllustrationReward(f),
      signal,
      8,
    );
    const after = await this.closeMailRewards(reward, signal);
    if (hasMailOneKeyClaim(after))
      throw new Error("邮件奖励已显示，但一键领取仍存在；停止且不重复确认");
    this.confirmedEffect("mail-claim", "已核对邮件奖励及邮箱无待领取附件");
    this.completedEffects();
    this.log("邮件附件已领取并确认邮箱无待领取项");
    return {
      status: "succeeded",
      summary: "邮件附件已领取，已核对无剩余待领取项",
      goalSatisfied: true,
      evidenceTimestamp: this.now().toISOString(),
      evidenceReference: "onmyoji:mail:reward-and-empty-mailbox",
      ...this.recordedEffects(),
    };
  }

  async dailyGift(signal: AbortSignal): Promise<SkillResult> {
    this.beginEffects("daily-gift");
    let courtyard = await this.courtyard(signal);
    const expanded = (f: Frame) =>
      isCourtyard(f) &&
      (!!findText(f, /^商店$/, [850, 800, 350, 280]) ||
        // 2026-10-17 实机：夜樱皮肤下「纳物库」常被 OCR 读成「图」「居」，
        // 导致整条 OR 分支失效；「花合战」同一条底栏、识别稳定，作为等价锚点补进来。
        (!!findText(f, /^阴阳寮$/, [700, 900, 300, 180]) &&
          (!!findText(f, /^纳物库$/, [400, 900, 230, 180]) ||
            !!findText(f, /^花合战$/, [1050, 900, 300, 180])) &&
          !!findText(f, /^式神录$/, [1550, 900, 260, 180])));
    let shopEntry = findText(courtyard, /^商店$/, [850, 800, 350, 280]);
    if (!expanded(courtyard)) {
      const closed =
        (await this.device.matchTemplate(
          "courtyard-menu-closed.png",
          [1700, 700, 220, 380],
          0.78,
          signal,
        )) ??
        (await this.device.matchFeatures?.(
          "courtyard-menu-closed.png",
          [1700, 700, 220, 380],
          signal,
        ));
      if (closed) {
        await this.tap(
          closed.box[0] + closed.box[2] / 2,
          closed.box[1] + closed.box[3] / 2,
          signal,
          1200,
        );
        courtyard = await this.waitFor(expanded, signal, 5);
        shopEntry = findText(courtyard, /^商店$/, [850, 800, 350, 280]);
        this.log("已展开庭院卷宗并核对功能栏布局");
      }
    }
    if (shopEntry) await this.text(shopEntry, signal);
    // 2026-10-17：**不要**按帧里量到的「商店」中心去改这个点。
    // 触摸坐标要经过 rotation=90 的换算（日志实测：帧内 680,655 → 设备 65,680），
    // 我按 1280×720 帧量出的 (1020,983) 换算后反而点空、进不去商店；
    // 原来的 (1025,955) 才是换算后正好落在「商店」上的那个点。
    else await this.tap(1025, 955, signal, 1400);
    // The shop remembers its previous district/tab, including limited-time
    // gifts. Verify its navigation before entering the unchanged free-gift flow.
    const shop = await this.waitFor(
      (f) => isShop(f) || isShopDistrict(f),
      signal,
      8,
    );
    this.rejectUnknownConfirmation(shop);
    const giftHouse = findText(shop, /^礼包屋$/, [1550, 930, 280, 150]);
    if (!giftHouse) throw new Error("商店未显示礼包屋入口");
    this.log("已核对商店导航入口，进入礼包屋并切换日常页");
    // The observed bottom label can receive a no-op. Its clickable icon sits
    // in the same verified navigation column, 60px above the label centre.
    await this.tap(
      giftHouse.box[0] + giftHouse.box[2] / 2,
      giftHouse.box[1] + giftHouse.box[3] / 2 - 60,
      signal,
    );
    const house = await this.waitFor(
      (f) => isGiftHouse(f) || !!centralConfirmation(f),
      signal,
      8,
    );
    this.rejectUnknownConfirmation(house);
    const dailyTab = dailyGiftTabPoint(house);
    if (!dailyTab) throw new Error("礼包屋日常页入口未能可靠定位，未点击商品");
    await this.tap(...dailyTab, signal);
    const list = await this.waitFor(isDailyGiftList, signal, 8);
    this.rejectUnknownConfirmation(list);
    const action = dailyGiftAction(list);
    if (!action) {
      const completed = !!findText(list, /^已领取$/, [180, 390, 360, 180]);
      let priced = false;
      if (!completed && hasPricedDailyGiftEntry(list)) {
        await this.pause(600, signal);
        const second = await this.shot(signal);
        this.rejectUnknownConfirmation(second);
        priced = hasPricedDailyGiftEntry(second);
      }
      if (completed) {
        this.confirmedEffect(
          "free-daily-gift",
          "已核对每日免费礼包已领取标记；未重复领取",
        );
        this.completedEffects();
      }
      await this.courtyard(signal);
      this.log(
        completed
          ? "每日免费礼包已确认领取，未触碰其他付费礼包"
          : priced
            ? "每日礼包入口连续两帧显示数字，疑似付费入口；当前未显示免费领取，未点击商品"
            : "免费礼包没有可确认的免费领取入口，领取状态无法确认；未触碰付费礼包",
      );
      return {
        status: "skipped",
        summary: completed
          ? "已确认每日免费礼包已领取，本次未重复领取"
          : priced
            ? "每日礼包入口显示数字，疑似付费入口；当前未显示免费领取，领取状态未确认，本次未点击"
            : "每日免费礼包未显示可确认的免费领取入口，领取状态未确认，本次未点击",
        skipReason: completed ? "already-completed" : "unavailable",
        goalSatisfied: completed ? true : null,
        evidenceTimestamp: this.now().toISOString(),
        evidenceReference: completed
          ? "onmyoji:daily-gift:completed-marker"
          : "onmyoji:daily-gift:free-claim-unavailable",
        ...this.recordedEffects(),
      };
    }
    this.submittingEffect();
    await this.text(action, signal);
    await this.waitFor(isDailyGiftReward, signal, 8);
    await this.tap(1700, 900, signal, 900);
    let after: Frame | undefined;
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = await this.shot(signal);
      if (isDailyGiftList(current)) {
        after = current;
        break;
      }
      if (isDailyGiftDetail(current)) {
        await this.tap(1700, 900, signal, 900);
        continue;
      }
      await this.pause(900, signal);
    }
    if (!after) throw new Error("每日礼包奖励结算后未返回日常列表");
    if (dailyGiftAction(after))
      throw new Error("奖励已显示但免费礼包仍可领取；停止且不重复点击");
    this.confirmedEffect(
      "free-daily-gift",
      "已核对每日免费礼包奖励及免费领取入口消失",
    );
    this.completedEffects();
    await this.courtyard(signal);
    this.log("每日免费礼包已领取，未触碰付费礼包");
    return {
      status: "succeeded",
      summary: "每日免费礼包已领取，已确认领取入口消失",
      goalSatisfied: true,
      evidenceTimestamp: this.now().toISOString(),
      evidenceReference: "onmyoji:daily-gift:reward-and-cleared-claim",
      ...this.recordedEffects(),
    };
  }

  private async openGuild(signal: AbortSignal): Promise<Frame> {
    const courtyard = await this.courtyard(signal);
    const label = findText(courtyard, /^阴阳寮$/, [700, 800, 360, 280]);
    if (label) {
      await this.text(label, signal);
      // 2026-10-14 更新后阴阳寮入口直接落在「寮境」：它是左侧活动行 + 底栏
      // 神社/祈愿/结界/寮信息 的布局，没有旧版 阴阳寮 标题锚点。
      return this.waitFor(
        (f) => isGuild(f) || isGuildRealm(f),
        signal,
        8,
      );
    }
    let entry = await this.device.matchTemplate(
      "guild-entry.png",
      [700, 800, 360, 280],
      0.78,
      signal,
    );
    if (!entry) {
      const toggle =
        (await this.device.matchTemplate(
          "courtyard-menu-toggle.png",
          [1700, 800, 220, 280],
          0.78,
          signal,
        )) ??
        (await this.device.matchFeatures?.(
          "courtyard-menu-closed.png",
          [1700, 700, 220, 380],
          signal,
        ));
      if (!toggle) {
        // Older courtyard layouts expose the guild at this stable bottom slot
        // and do not contain the current roll-up menu control.
        await this.tap(855, 955, signal, 1500);
        return this.waitFor((f) => isGuild(f) || isGuildRealm(f), signal, 8);
      }
      await this.tap(
        toggle.box[0] + toggle.box[2] / 2,
        toggle.box[1] + toggle.box[3] / 2,
        signal,
        1200,
      );
      entry =
        (await this.device.matchTemplate(
          "guild-entry.png",
          [700, 800, 360, 280],
          0.78,
          signal,
        )) ??
        (await this.device.matchFeatures?.(
          "guild-entry.png",
          [700, 800, 360, 280],
          signal,
        )) ??
        null;
    }
    if (!entry) throw new Error("庭院功能栏已展开，但未找到阴阳寮入口");
    await this.tap(
      entry.box[0] + entry.box[2] / 2,
      entry.box[1] + entry.box[3] / 2,
      signal,
      1500,
    );
    return this.waitFor((f) => isGuild(f) || isGuildRealm(f), signal, 8);
  }

  private async collectivePage(signal: AbortSignal) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const frame = await this.shot(signal);
      if (findText(frame, /^获得奖励$/, [500, 100, 900, 500])) {
        await this.tap(1700, 900, signal, 1500);
        continue;
      }
      if (isCollectiveTaskPage(frame)) return frame;
      await this.pause(1200, signal);
    }
    throw new Error("集体任务奖励动画未结束或任务页面未确认");
  }
  async guildQuest(signal: AbortSignal): Promise<SkillResult> {
    this.beginEffects("guild-quest");
    const realm = await this.openGuild(signal);
    // 2026-10 新版：阴阳寮 → 寮境，集体任务在左栏第一行（旧版走神社，已不适用）。
    const entry = findText(realm, /^集体任务/, [0, 150, 340, 640]);
    if (!entry) throw new Error("寮境未显示集体任务入口");
    await this.text(entry, signal);
    let tasks = await this.collectivePage(signal);
    const progress = collectiveProgress(tasks);
    if (!progress) throw new Error("无法确认阴阳寮集体任务总进度");

    // 只领已经拿到的奖励（零成本）。「提交」卡要提供 N 阶式神，会消耗式神，
    // 那是大人的取舍：这里不自动做，只在摘要里如实说明它还在。
    let claimed = 0;
    let lastBox: [number, number, number, number] | undefined;
    for (; claimed < 3; ) {
      const claim = collectiveClaimAction(tasks);
      if (!claim) break;
      // 只有"同一张卡领完还显示可领"才算异常：不同卡各自可领是正常的，不能因此停下。
      if (
        lastBox &&
        Math.abs(claim.box[0] - lastBox[0]) <= 20 &&
        Math.abs(claim.box[1] - lastBox[1]) <= 20
      )
        throw new Error("集体任务奖励结算后仍显示可领取，停止重复点击");
      this.submittingEffect();
      lastBox = [claim.box[0], claim.box[1], claim.box[2], claim.box[3]];
      await this.text(claim, signal);
      tasks = await this.collectivePage(signal);
      claimed++;
      this.log(`阴阳寮集体任务已领取第 ${claimed} 项奖励`);
    }
    const pendingSubmit = Boolean(collectiveSubmitAction(tasks));
    this.confirmedEffect(
      "guild-reward",
      claimed
        ? `已领取 ${claimed} 项集体任务奖励；今日进度 ${progress.completed}/${progress.total}`
        : `集体任务今日进度 ${progress.completed}/${progress.total}；暂无可领取奖励`,
    );
    if (pendingSubmit)
      this.log(
        "集体任务仍有「提交」卡（需提供 N 阶式神），会消耗式神，本次不自动提交",
      );
    // 新版集体任务面板是全屏页，只有右上角的 × 能关（点击空白处无效）；
    // 实测关闭点在 (1780,177)，旧版的 (1755,180) 点不到。
    await this.tap(1780, 177, signal, 1200);
    await this.courtyard(signal);
    this.completedEffects();
    return {
      // 有奖励可领就是做事了；一条都没有时如实报「无可领取」，不假装完成。
      status: claimed ? ("succeeded" as const) : ("skipped" as const),
      ...(claimed ? {} : { skipReason: "nothing-to-claim" as const }),
      goalSatisfied: true,
      evidenceTimestamp: this.now().toISOString(),
      evidenceReference: claimed
        ? "onmyoji:guild-quest:claimed-collective-rewards"
        : "onmyoji:guild-quest:nothing-to-claim",
      ...this.recordedEffects(),
      summary: `阴阳寮集体任务已核对 ${progress.completed}/${progress.total}${
        claimed ? `，领取 ${claimed} 项奖励` : "，暂无可领取奖励"
      }${pendingSubmit ? "；仍有需消耗式神的提交卡，未自动提交" : ""}`,
    };
  }

  async hanaClaim(signal: AbortSignal): Promise<SkillResult> {
    this.beginEffects("hana-claim");
    const courtyard = await this.courtyard(signal);
    const entry = findText(courtyard, /^(花合战|合战)$/, [1050, 830, 400, 250]);
    if (entry) await this.text(entry, signal);
    else {
      let icon = await this.device.matchTemplate(
        "hana-entry.png",
        [1050, 830, 400, 250],
        0.78,
        signal,
      );
      if (!icon) {
        const toggle =
          (await this.device.matchTemplate(
            "courtyard-menu-toggle.png",
            [1700, 800, 220, 280],
            0.78,
            signal,
          )) ??
          (await this.device.matchTemplate(
            "courtyard-menu-closed.png",
            [1700, 700, 220, 380],
            0.78,
            signal,
          )) ??
          (await this.device.matchFeatures?.(
            "courtyard-menu-closed.png",
            [1700, 700, 220, 380],
            signal,
          ));
        if (toggle) {
          await this.tap(
            toggle.box[0] + toggle.box[2] / 2,
            toggle.box[1] + toggle.box[3] / 2,
            signal,
            1200,
          );
          const opened = await this.shot(signal);
          const textEntry = isCourtyard(opened)
            ? findText(opened, /^(花合战|合战)$/, [1050, 830, 400, 250])
            : undefined;
          icon =
            textEntry ??
            (await this.device.matchTemplate(
              "hana-entry.png",
              [1050, 830, 400, 250],
              0.78,
              signal,
            ));
        }
      }
      icon ??=
        (await this.device.matchFeatures?.(
          "hana-entry.png",
          [1050, 830, 400, 250],
          signal,
        )) ?? null;
      if (icon)
        await this.tap(
          icon.box[0] + icon.box[2] / 2,
          icon.box[1] + icon.box[3] / 2,
          signal,
        );
      else if (isCourtyard(courtyard)) {
        // 2026-10-14 新庭院底栏把 商店 与 花合战 相邻排版，实测 OCR 会把两枚标签
        // 并成一串（"商店“花合战" 0.763），整词锚点与模板兜底同时失效；当前版本
        // 底栏槽位固定（花合战标签中心实测 (1192,1002)/1920），只在已确认庭院时使用。
        this.log("花合战标签未可靠识别，改用当前庭院底栏槽位");
        await this.tap(1192, 1002, signal, 1400);
      } else throw new Error("庭院未显示花合战入口");
    }
    let hana = await this.waitFor(isHanaPage, signal, 8);
    if (!isHanaTaskPage(hana)) {
      const taskTab = findText(hana, /^任务$/, [1700, 380, 220, 320]);
      if (!taskTab)
        throw new Error("花合战任务页入口未确认，未将按钮缺失当作无奖励");
      await this.text(taskTab, signal);
    }
    hana = await waitForStableFrame(
      () => this.shot(signal),
      hanaTaskState,
      signal,
      this.pause,
    );
    const claim = hanaClaimAction(hana);
    if (!claim) {
      this.log("花合战没有待领取奖励");
    } else {
      this.submittingEffect();
      await this.text(claim, signal);
      const result = await waitForStableFrame(
        () => this.shot(signal),
        (f) =>
          isHanaReward(f)
            ? "reward"
            : hanaTaskState(f) === "empty"
              ? "empty"
              : null,
        signal,
        this.pause,
      );
      if (isHanaReward(result)) await this.tap(1700, 900, signal, 900);
      hana = await waitForStableFrame(
        () => this.shot(signal),
        hanaTaskState,
        signal,
        this.pause,
      );
      if (hanaClaimAction(hana))
        throw new Error("花合战奖励后仍显示全部领取，停止重复点击");
      this.log("花合战全部奖励已领取");
    }
    this.confirmedEffect(
      "hana-claim",
      claim
        ? "已核对花合战任务页无待领取奖励"
        : "已核对花合战无待领取奖励；未重复领取",
    );
    this.completedEffects();
    await this.tap(75, 60, signal, 1200);
    await this.waitFor(isCourtyard, signal, 8);
    return {
      status: claim ? "succeeded" : "skipped",
      ...(!claim ? { skipReason: "nothing-to-claim" as const } : {}),
      goalSatisfied: true,
      evidenceTimestamp: this.now().toISOString(),
      evidenceReference: "onmyoji:hana-claim:verified-no-pending-reward",
      ...this.recordedEffects(),
      summary: claim
        ? "花合战奖励已领取并返回庭院"
        : "花合战已核对，无待领取奖励",
    };
  }

  private async fosterTop(signal: AbortSignal) {
    let previous: FosterRow[] = [];
    let stationary = 0;
    for (let attempt = 0; attempt < 96; attempt++) {
      const frame = await this.waitFor(isFosterFriendList, signal, 5);
      if (findText(frame, /^请输入好友昵称或备注$/, [320, 230, 450, 100]))
        return frame;
      const rows = fosterNames(frame);
      stationary = sameFosterPage(previous, rows) ? stationary + 1 : 0;
      if (stationary >= 2) return frame;
      previous = rows;
      // Start inside the friend list, below the search input at y=250–315.
      await this.device.swipe(700, 420, 700, 850, signal);
      await this.pause(500, signal);
    }
    throw new Error("好友结界列表无法回到顶部");
  }

  private async leaveToCourtyard(signal: AbortSignal) {
    let backs = 0;
    for (let attempt = 0; attempt < 24; attempt++) {
      const current = await this.shot(signal);
      if (isCourtyard(current)) return;
      // A realm decoration can cover the last character of the right-hand sign.
      // This two-anchor fallback permits back navigation only, never entering training.
      const leftSign = findText(current, /^结界防守$/, [300, 300, 400, 500]);
      const rightSign = findText(current, /^结界$/, [1100, 300, 450, 500]);
      const coveredRealm =
        leftSign &&
        rightSign &&
        Math.abs(leftSign.box[1] - rightSign.box[1]) <= 100;
      // Friend realm skins may split or omit the left vertical sign. Require
      // the realm title and an independent control, for back navigation only.
      const friendRealmOverview =
        findText(current, /.+的结界$/, [600, 0, 700, 160]) &&
        (findText(current, /^寄$/, [900, 220, 220, 140]) ||
          findText(current, /^结界卡$/, [1100, 300, 450, 500]));
      if (
        !findText(current, /^式神育成$/, [0, 0, 450, 180]) &&
        !isGuild(current) &&
        // 2026-10-14 实测：寄养结束后的返回路径是 式神育成 → 结界 → 寮境 → 庭院，
        // 寮境不在旧清单里，于是这里干等到 24 次上限并报「未能返回庭院」。
        !isGuildRealm(current) &&
        !ownTrainingEntry(current) &&
        !coveredRealm &&
        !friendRealmOverview
      ) {
        await this.pause(1200, signal);
        continue;
      }
      if (backs >= 6) break;
      await this.tap(60, 60, signal, 1100);
      backs++;
    }
    if (isCourtyard(await this.shot(signal))) return;
    throw new TaskFaultError(
      "foster-return-failed",
      "结界寄养流程未能返回庭院",
    );
  }

  private async fosterStars(y: number, signal: AbortSignal) {
    const slots: [number, number, number, number][] = [
      832, 844, 856, 868, 880, 892,
    ].map((x) => [x - 5, y + 22, 10, 24]);
    const active = await this.device.colorSlots(
      slots,
      [0, 140, 120],
      [25, 255, 255],
      100,
      signal,
    );
    if (active.length !== 6) throw new Error("好友结界星位识别结果不完整");
    const stars = active.filter(Boolean).length;
    return stars >= 1 && stars <= 6 ? stars : 0;
  }

  private async fosterPanelStars(signal: AbortSignal) {
    const slots: [number, number, number, number][] = [
      1270, 1292, 1314, 1336, 1358, 1380,
    ].map((x) => [x - 8, 485, 16, 30]);
    const active = await this.device.colorSlots(
      slots,
      [0, 140, 120],
      [25, 255, 255],
      180,
      signal,
    );
    const count = active.filter(Boolean).length;
    if (
      active.length !== 6 ||
      count < 1 ||
      active.some((value, index) => value !== index < count)
    )
      throw Error("结界卡详情星级未能连续确认，停止选择");
    return count;
  }

  private async findUnusedWhiteDaruma(current: Frame, signal: AbortSignal) {
    let daruma: {
      box: [number, number, number, number];
      score: number;
    } | null = null;
    // Verify the replacement before removing anything. The rightmost visible
    // unused candidate is the lowest-level unit in the current sort order.
    for (const candidateX of [1500, 1300, 1100, 900, 700, 500, 300]) {
      if (findText(current, /^育$/, [candidateX - 110, 780, 220, 230]))
        continue;
      daruma = await this.device.matchTemplate(
        "foster-white-daruma.png",
        [candidateX - 100, 730, 240, 290],
        0.78,
        signal,
      );
      daruma ??=
        (await this.device.matchFeatures?.(
          "foster-white-daruma.png",
          [candidateX - 100, 730, 240, 290],
          signal,
        )) ?? null;
      if (
        daruma &&
        ((await this.device.matchTemplate(
          "training-level-one.png",
          [candidateX - 100, 730, 130, 100],
          0.9,
          signal,
        )) ??
          (await this.device.matchTemplate(
            "training-level-one-stack.png",
            [candidateX - 100, 730, 130, 100],
            0.9,
            signal,
          )))
      )
        break;
      daruma = null;
    }
    return daruma;
  }

  private async refreshOwnTraining(training: Frame, signal: AbortSignal) {
    const centers = [170, 490, 810, 1130, 1450, 1770];
    // Full units show a gold 满 badge in place of the level. Their XP bar
    // can be nearly empty, while a non-full level can have a full green bar.
    const indexes: number[] = [];
    for (let index = 0; index < centers.length; index++) {
      const full = await this.device.matchTemplate(
        "training-full.png",
        [centers[index] - 95, 340, 90, 90],
        0.9,
        signal,
      );
      if (
        full ||
        findText(training, /^放入式神$/, [centers[index] - 105, 535, 210, 100])
      )
        indexes.push(index);
    }
    if (!indexes.length) {
      this.log("自有结界没有确认满级标记的式神，无需更换");
      return training;
    }
    let current = training;
    for (const index of indexes) {
      const x = centers[index];
      const wasEmpty = !!findText(current, /^放入式神$/, [
        x - 105,
        535,
        210,
        100,
      ]);
      let daruma = await this.findUnusedWhiteDaruma(current, signal);
      if (!daruma)
        throw new Error("没有可确认的 1 级白色达摩，保留现有育成式神");
      if (!wasEmpty) {
        await this.tap(x, 470, signal, 900);
        current = await this.waitFor(
          (frame) =>
            isTrainingPage(frame) &&
            !!findText(frame, /^放入式神$/, [x - 105, 535, 210, 100]),
          signal,
          5,
        );
        // Removing a unit changes inventory order and can put an in-use unit
        // at the previous candidate coordinates. Always reselect from this frame.
        daruma = await this.findUnusedWhiteDaruma(current, signal);
        if (!daruma)
          throw new Error(
            "卸下后未能重新确认未在育成的 1 级白色达摩，停止更换",
          );
      }
      await this.tap(
        daruma.box[0] + daruma.box[2] / 2,
        daruma.box[1] + daruma.box[3] / 2,
        signal,
        900,
      );
      let replaced = false;
      for (let attempt = 0; attempt < 8; attempt++) {
        current = await this.shot(signal);
        const confirm = findText(
          current,
          /^(确认|确定)$/,
          [650, 350, 700, 450],
        );
        if (confirm) {
          await this.text(confirm, signal);
          continue;
        }
        const placed =
          (await this.device.matchTemplate(
            "foster-white-daruma.png",
            [x - 105, 300, 210, 320],
            0.78,
            signal,
          )) ??
          (await this.device.matchFeatures?.(
            "foster-white-daruma.png",
            [x - 105, 300, 210, 320],
            signal,
          ));
        if (placed) {
          replaced = true;
          break;
        }
        await this.pause(800, signal);
      }
      if (!replaced)
        throw new Error(`第 ${index + 1} 个育成槽未确认换成白色达摩`);
      this.log(
        wasEmpty
          ? `自有结界第 ${index + 1} 个空槽已放入白色达摩`
          : `自有结界第 ${index + 1} 个满级式神已换成白色达摩`,
      );
    }
    return current;
  }

  private async fosterResult(
    outcome: "active" | "started",
    frame: Frame,
    signal: AbortSignal,
  ) {
    const first = fosterRemainingSeconds(frame);
    let remaining: number | null = null;
    if (first !== null) {
      const before = this.now().getTime();
      await this.pause(600, signal);
      const second = fosterRemainingSeconds(await this.shot(signal));
      const elapsed = Math.ceil((this.now().getTime() - before) / 1000);
      if (
        second !== null &&
        second <= first &&
        first - second <= Math.max(10, elapsed + 3)
      )
        remaining = second;
    }
    const result = fosterScheduleResult(outcome, this.now(), remaining);
    this.log(
      remaining !== null
        ? `寄养剩余 ${remaining} 秒，下次检查 ${new Date(result.nextRunAt).toLocaleString()}`
        : outcome === "started"
          ? "新寄养已确认，按六小时安排下次检查"
          : "寄养倒计时未确认，30 分钟后复查；未重置为新的六小时寄养",
      result,
    );
    return result;
  }

  private async stableFosterSelection(signal: AbortSignal) {
    return waitForStableFrame(
      () => this.shot(signal),
      (f) => {
        if (!isFosterFriendList(f)) return null;
        const reward = findText(
          f,
          /^[\u4e00-\u9fff]{2,8}\+\d+$/,
          [1100, 550, 450, 180],
        );
        const enter = findText(f, /^进入结界$/, [1050, 700, 500, 260]);
        const panel = f.texts
          .filter(
            (h) =>
              h.box[0] >= 1100 &&
              h.box[0] < 1550 &&
              h.box[1] >= 500 &&
              h.box[1] < 730,
          )
          .map((h) => h.text.replace(/\s/g, ""))
          .sort()
          .join("|");
        return reward && enter
          ? `${panel}|${Math.round(enter.box[0] / 20)}|${Math.round(enter.box[1] / 20)}`
          : null;
      },
      signal,
      this.pause,
      6,
    );
  }

  private async openFosterTraining(signal: AbortSignal) {
    const guild = await this.openGuild(signal);
    // 2026-10-14 寮境底栏是 神社/祈愿/结界/寮信息，结界 实测中心在 (1680,984)；
    // 旧版神社页仍沿用 (1630,985)。
    await this.tap(isGuildRealm(guild) ? 1680 : 1630, 985, signal, 1500);
    // Alternate realm skins move the training sign; use both neighboring labels
    // when visible, with the original layout as the initial fallback.
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = await this.shot(signal);
      if (isTrainingPage(current)) return current;
      // 育成入口是悬挂的木牌（竖排美术字），OCR 时好时坏：2026-10-15 在 lane-b 上
      // 「式神育成」整块读不出，兜底又点在达摩区（点不动），整步失败。
      // 现在按 标签文字 → 木牌模板 → 实测兜底点 的顺序找。
      const label = ownTrainingEntry(current);
      const template = label
        ? undefined
        : ((await this.device.matchTemplate?.(
            "training-entry.png",
            [700, 420, 700, 520],
            0.8,
            signal,
          )) ??
          (await this.device.matchFeatures?.(
            "training-entry.png",
            [700, 420, 700, 520],
            signal,
          )));
      const target: [number, number] | undefined =
        label ??
        (template
          ? [
              template.box[0] + template.box[2] / 2,
              template.box[1] + template.box[3] / 2,
            ]
          : undefined);
      if (target) {
        await this.tap(...target, signal, 1300);
        return this.waitFor(isTrainingPage, signal, 6);
      }
      // 实测的木牌中心（lane-b 结界皮肤）：旧的 (975,550) 落在达摩区，点了没反应。
      if (attempt === 0) await this.tap(920, 615, signal, 1300);
      else await this.pause(900, signal);
    }
    throw new Error("结界已打开，但无法进入式神育成");
  }

  async foster(signal: AbortSignal) {
    let training = await this.openFosterTraining(signal);
    training = await this.refreshOwnTraining(training, signal);
    if (findText(training, /^我的寄养$/, [1450, 0, 450, 280])) {
      const result = await this.fosterResult("active", training, signal);
      this.log("已有式神正在好友结界寄养，无需重复安排");
      await this.leaveToCourtyard(signal);
      return result;
    }
    await this.tap(1775, 135, signal, 1300);
    await this.waitFor(isFosterFriendList, signal, 8);
    let frame = await this.fosterTop(signal);
    const candidates: NamedFosterCandidate[] = [];
    let previous: FosterRow[] = [];
    let stationary = 0;
    const seen = new Set<string>();
    const observedFriends = new Set<string>();
    let tryMaximumEarly = true;
    scan: for (let page = 0; page < 64; page++) {
      const rows = fosterNames(frame);
      if (!rows.length) throw Error("好友列表未识别到名称，无法确认候选范围");
      stationary = sameFosterPage(previous, rows) ? stationary + 1 : 0;
      if (stationary >= 2) break;
      if (page === 63)
        throw new TaskFaultError(
          "foster-scan-limit",
          "好友列表超过扫描上限，未确认最高星候选",
        );
      previous = rows;
      for (const row of rows)
        if (row.y >= 290 && row.y <= 850) observedFriends.add(row.name);
      for (let row = 0; row < rows.length; row++) {
        if (rows[row].y < 290 || rows[row].y > 850 || seen.has(rows[row].name))
          continue;
        // Small moving list icons only indicate a candidate, not its rank.
        if (!(await this.fosterStars(rows[row].y, signal))) continue;
        seen.add(rows[row].name);
        // The list itself remains a valid page while the right-hand reward panel
        // is still changing. Waiting only for the page predicate can therefore
        // read the previously selected friend's reward type. Give the panel one
        // complete animation before classifying this row.
        await this.tap(650, rows[row].y, signal, 1200);
        const selected = await this.stableFosterSelection(signal);
        if (!isFosterFriendList(selected))
          throw new Error("选择好友结界后列表状态异常");
        const kind = fosterCardKind(selected);
        if (kind) {
          const stars = await this.fosterPanelStars(signal);
          const candidate = { name: rows[row].name, kind, stars, page, row };
          // Six-star Taiko is the maximum possible rank. Availability must still
          // be checked, but scanning lower-ranked rows cannot improve this choice.
          if (tryMaximumEarly && kind === "taiko" && stars === 6) {
            tryMaximumEarly = false;
            this.log(
              "第 " +
                (page + 1) +
                " 页已确认六星太鼓，直接复核空位；已检查 " +
                seen.size +
                " 位好友",
            );
            const result = await this.tryFosterCandidate(
              candidate,
              signal,
              selected,
            );
            if (result) return result;
            // Restart the page budget only once. Further maximum candidates are
            // queued until this full traversal ends, avoiding repeated top resets.
            frame = await this.fosterTop(signal);
            previous = [];
            stationary = 0;
            page = -1;
            this.log(
              "六星候选不可用，从顶部重新完整扫描一次；后续候选统一排序复核",
            );
            continue scan;
          }
          candidates.push(candidate);
        }
      }
      this.log(
        `${tryMaximumEarly ? "首次扫描" : "重新扫描"}好友列表第 ${page + 1} 页，累计识别 ${observedFriends.size} 位好友，核对 ${seen.size} 个有卡好友，保留 ${candidates.length} 个太鼓/斗鱼候选`,
      );
      // Keep overlapping rows so partially clipped friends are visible on the next page.
      await this.device.swipe(700, 800, 700, 500, signal);
      await this.pause(700, signal);
      frame = await this.waitFor(isFosterFriendList, signal, 5);
    }
    while (candidates.length) {
      const choice = chooseFosterCandidate(candidates);
      const best = choice
        ? candidates.find(
            (candidate) =>
              candidate.kind === choice.kind &&
              candidate.stars === choice.stars &&
              candidate.page === choice.page &&
              candidate.row === choice.row,
          )
        : undefined;
      if (!best) break;
      candidates.splice(candidates.indexOf(best), 1);
      const result = await this.tryFosterCandidate(best, signal);
      if (result) return result;
    }
    this.log("没有可用且可确认的太鼓/斗鱼好友结界，30 分钟后复查");
    await this.leaveToCourtyard(signal);
    return fosterScheduleResult("unavailable", this.now(), null);
  }

  private async tryFosterCandidate(
    best: NamedFosterCandidate,
    signal: AbortSignal,
    currentSelection?: Frame,
  ) {
    this.log(
      `寄养候选：${best.name} · ${best.stars} 星${best.kind === "taiko" ? "太鼓" : "斗鱼"}`,
    );
    // A maximum-rank candidate is still visible on the page we just selected.
    // Keep that location, then reselect and verify it below before entering.
    if (
      currentSelection &&
      (!isFosterFriendList(currentSelection) ||
        !fosterNames(currentSelection).some(
          (row) => row.name === best.name && row.y >= 290 && row.y <= 850,
        ))
    )
      throw Error("当前寄养候选名称无法重新确认，停止选择");
    let frame = currentSelection ?? (await this.fosterTop(signal));
    let target: ReturnType<typeof fosterNames>[number] | undefined;
    let priorRows: FosterRow[] = [];
    let stationary = 0;
    for (let attempt = 0; attempt < 64; attempt++) {
      const found = fosterNames(frame).find((row) => row.name === best.name);
      if (found && found.y >= 290 && found.y <= 850) {
        target = found;
        break;
      }
      const rows = fosterNames(frame);
      stationary = sameFosterPage(priorRows, rows) ? stationary + 1 : 0;
      if (stationary >= 2) break;
      priorRows = rows;
      await this.device.swipe(700, 800, 700, 500, signal);
      await this.pause(700, signal);
      frame = await this.waitFor(isFosterFriendList, signal, 5);
    }
    if (!target) {
      this.log(`好友 ${best.name} 已变化或无法再次确认，检查下一候选`);
      return undefined;
    }
    await this.tap(650, target.y, signal, 1200);
    const selected = await this.stableFosterSelection(signal);
    if (!isFosterFriendList(selected))
      throw new Error("复核好友结界时列表状态异常");
    const verifiedKind = fosterCardKind(selected);
    if (
      verifiedKind !== best.kind ||
      (await this.fosterPanelStars(signal)) !== best.stars
    ) {
      this.log(`好友 ${best.name} 结界卡已变化，检查下一候选`);
      return undefined;
    }
    const enter = findText(selected, /^进入结界$/, [1050, 700, 500, 260]);
    if (!enter) throw new Error("最高星级好友未显示进入结界按钮");
    await this.text(enter, signal);
    const realm = await this.waitFor(
      (f) => isFriendRealm(f) || isFosterActive(f),
      signal,
      8,
    );
    if (!isFriendRealm(realm)) {
      this.log(`好友 ${best.name} 寄养位已占用，检查下一候选`);
      await this.leaveToCourtyard(signal);
      await this.openFosterTraining(signal);
      await this.tap(1775, 135, signal, 1300);
      await this.waitFor(isFosterFriendList, signal, 8);
      return undefined;
    }
    const realmTitle = findText(realm, /的结界$/, [600, 0, 700, 160]);
    if (
      realmTitle?.text.normalize("NFKC").replace(/\s/g, "") !==
      best.name + "的结界"
    )
      throw Error("好友结界名称与候选不一致，停止放入式神");
    const daruma =
      (await this.device.matchTemplate(
        "foster-white-daruma.png",
        [200, 700, 500, 330],
        0.78,
        signal,
      )) ??
      (await this.device.matchFeatures?.(
        "foster-white-daruma.png",
        [200, 700, 500, 330],
        signal,
      ));
    if (!daruma) throw new Error("没有识别到可寄养的白色达摩，停止选择");
    if (
      !(await this.device.matchTemplate(
        "training-level-one.png",
        [200, 720, 250, 120],
        0.9,
        signal,
      ))
    )
      throw Error("寄养候选未确认一级白达摩，停止选择");
    await this.tap(
      daruma.box[0] + daruma.box[2] / 2,
      daruma.box[1] + daruma.box[3] / 2,
      signal,
      900,
    );
    await this.waitFor(
      (f) => !!findText(f, /寄养获得额外40%收益/, [600, 600, 750, 220]),
      signal,
      8,
    );
    const ok = await this.device.matchTemplate(
      "foster-confirm.png",
      [850, 650, 500, 300],
      0.78,
      signal,
    );
    if (!ok) throw new Error("寄养确认按钮缺失");
    await this.tap(
      ok.box[0] + ok.box[2] / 2,
      ok.box[1] + ok.box[3] / 2,
      signal,
      1200,
    );
    const completed = await this.waitFor(isFosterActive, signal, 10);
    if (!isFosterActive(completed)) throw new Error("未能确认寄养完成");
    const result = await this.fosterResult("started", completed, signal);
    this.log(
      `已选择 ${best.stars} 星${best.kind === "taiko" ? "太鼓" : "斗鱼"}好友 ${best.name}，寄养 1 级式神`,
    );
    await this.leaveToCourtyard(signal);
    return result;
  }

  async guildKirin(
    signal: AbortSignal,
    now = new Date(),
  ): Promise<SkillResult> {
    if (!isGuildKirinWindow(now)) {
      this.log("当前不在周一至周四 06:00-23:00 开放时段，跳过阴阳寮麒麟");
      return {
        status: "skipped",
        summary: "不在麒麟开放时段（周一至周四 06:00–23:00）",
        skipReason: "not-open",
        goalSatisfied: null,
        evidenceTimestamp: now.toISOString(),
        evidenceReference: "onmyoji:guild-kirin:calendar",
      };
    }
    const guild = await this.openGuild(signal);
    if (isGuildRealm(guild)) {
      // 寮境活动排序随阴阳寮变化：道馆等入口会把狩猎战挤到第三或第四行。
      // 仅在左侧活动列表中精确找行标签，进入后仍独立核对麒麟与挑战状态。
      const row = findText(guild, /^狩猎战$/, [0, 200, 360, 510]);
      if (!row) throw new Error("寮境未显示狩猎战入口");
      await this.text(row, signal);
    } else {
      await this.tap(1350, 985, signal, 1200);
      const shrine = await this.waitFor(isShrine, signal, 8);
      const huntEntry = findText(shrine, /^狩猎战$/, [200, 500, 420, 260]);
      if (!huntEntry) throw new Error("神社未显示狩猎战入口");
      await this.text(huntEntry, signal);
    }
    let hunt: Frame | undefined;
    for (let attempt = 0; attempt < 6; attempt++) {
      const current = await this.shot(signal);
      if (isKirinHunt(current)) {
        hunt = current;
        break;
      }
      if (isShrine(current)) {
        await this.pause(1000, signal);
        continue;
      }
      await this.pause(1000, signal);
    }
    if (!hunt) {
      this.log(
        "未进入可确认的狩猎战画面，麒麟开放及完成状态未知；本次不发起挑战",
      );
      await this.courtyard(signal);
      return {
        status: "skipped",
        summary: "未进入可确认的狩猎战，本次未发起挑战",
        skipReason: "unknown",
        goalSatisfied: null,
        evidenceTimestamp: this.now().toISOString(),
        evidenceReference: "onmyoji:guild-kirin:hunt-unconfirmed",
      };
    }
    const challenge = findText(hunt, /^挑战$/, [1580, 800, 340, 260]);
    const unchallenged = findText(
      hunt,
      /大人未挑战|继续挑战残影/,
      [0, 480, 1920, 420],
    );
    const reliableHunt = {
      ...hunt,
      texts: hunt.texts.filter((hit) => hit.score >= 0.9),
    };
    const completed =
      !!findText(hunt, /^(大人)?已挑战$/, [0, 480, 1920, 420]) ||
      // Observed 1920x1080 completed hunt: the disabled bottom button lies
      // below the legacy status row. Require its independent success marker.
      (hunt.width === 1920 &&
        hunt.height === 1080 &&
        !centralConfirmation(hunt) &&
        isKirinHunt(reliableHunt) &&
        !!findText(reliableHunt, /^狩猎成功$/, [1100, 760, 300, 150]) &&
        !!findText(reliableHunt, /^已挑战$/, [1600, 880, 300, 150]));
    if (completed || !challenge || !unchallenged) {
      this.log(
        completed
          ? "已确认今日麒麟已挑战，无需挑战"
          : "当前麒麟不可挑战，是否已完成无法确认；本次不发起挑战",
      );
      await this.courtyard(signal);
      return {
        status: "skipped",
        summary: completed
          ? "已确认今日麒麟已挑战，本次未开战"
          : "当前麒麟不可挑战，今日参与状态未确认，本次未开战",
        skipReason: completed ? "already-completed" : "unavailable",
        goalSatisfied: completed ? true : null,
        evidenceTimestamp: this.now().toISOString(),
        evidenceReference: completed
          ? "onmyoji:guild-kirin:explicit-completed-marker"
          : "onmyoji:guild-kirin:challenge-unavailable",
      };
    }
    this.log("雷麒麟可挑战，使用当前阵容开始唯一一次挑战");
    await this.text(challenge, signal);
    const readyFrame = await this.waitFor(
      (frame) => !!findText(frame, /^准备$/, [1580, 700, 340, 300]),
      signal,
      10,
    );
    const ready = findText(readyFrame, /^准备$/, [1580, 700, 340, 300]);
    if (!ready) throw new Error("未能确认麒麟准备按钮");
    await this.text(ready, signal);
    let entered = false;
    for (let attempt = 0; attempt < 150; attempt++) {
      await this.pause(1800, signal);
      const frame = await this.shot(signal);
      if (findText(frame, /失败|战败/, [700, 80, 1000, 500]))
        throw new Error("麒麟挑战失败；不会自动重试，请调整当前阵容");
      if (isKirinVictory(frame)) {
        this.log("麒麟挑战胜利，已确认本次伤害结算");
        await this.tap(960, 1028, signal, 1200);
        await this.courtyard(signal);
        return {
          status: "succeeded",
          summary: "麒麟挑战胜利，已确认本次伤害结算",
          goalSatisfied: true,
          evidenceTimestamp: this.now().toISOString(),
          evidenceReference: "onmyoji:guild-kirin:victory-settlement",
        };
      }
      if (
        findText(frame, /^(自动|手动)$/, [0, 850, 220, 230]) &&
        findText(frame, /^当前成绩$/, [0, 40, 360, 220])
      )
        entered = true;
      else if (entered && isKirinHunt(frame))
        throw new Error("麒麟战斗已返回活动页但没有胜利结算；不会重复挑战");
    }
    throw new Error("麒麟战斗等待超时；不会重复挑战，请在模拟器检查结果");
  }
  private async map(signal: AbortSignal): Promise<Frame> {
    for (let i = 0; i < 15; i++) {
      const f = await this.shot(signal);
      if (isDetail(f)) {
        await this.tap(1812, 60, signal);
        continue;
      }
      if (isMap(f)) return f;
      if (isExploration(f)) {
        // 旧版布局：能取到独立的「地域鬼王」盒子时沿用实测图标坐标 (1000,984)。
        // 2026-10-14 更新后探索页把底栏入口排成一整条，OCR 并成一串
        // （"式神委派秘闻副本地域鬼王妖气探索英杰试炼契灵之境六道之" 0.982），
        // 取不到独立盒子，因此用实测槽位 (987,960)：该点已实机确认进入地域鬼王。
        const exact = findText(f, /^地域鬼王$/, [550, 900, 1100, 180]);
        await this.tap(
          ...((exact ? [1000, 984] : [987, 960]) as [number, number]),
          signal,
          1800,
        );
        continue;
      }
      if (isCourtyard(f)) {
        const exploration = findText(f, /^(探索|探)$/, [300, 100, 1200, 650]);
        if (!exploration) {
          await this.pause(1200, signal);
          continue;
        }
        await this.text(exploration, signal);
        continue;
      }
      await this.pause(1200, signal);
    }
    throw new Error("进入地域鬼王失败");
  }
  async realmRaid(signal: AbortSignal): Promise<SkillResult> {
    const day = gameDay();
    let f = await this.map(signal);
    const reputationHit = findText(f, /^\d{1,6}$/, [1750, 70, 170, 100]);
    if (!reputationHit) throw new Error("无法可靠读取声望，停止挑战");
    const reputation = Number(reputationHit.text),
      quota = quotaFor(reputation);
    f = await this.shot(signal);
    if (
      Number(findText(f, /^\d{1,6}$/, [1750, 70, 170, 100])?.text) !==
      reputation
    )
      throw new Error("声望两次识别不一致，停止挑战");
    this.log(`${day} · 声望 ${reputation} · 今日目标 ${quota} 个不同鬼王`);
    const completed = new Set<string>();
    let newChallenges = 0;
    // The observed 今日挑战 strip contains already attempted bosses. Verify each detail;
    // never interpret portrait count or another player's score as a completed run.
    for (let slot = 0; slot < quota; slot++) {
      await this.map(signal);
      await this.tap(110, 600, signal);
      await this.tap([300, 465, 635][slot], 600, signal);
      f = await this.shot(signal);
      if (!isDetail(f)) {
        this.log("今日记录中没有可确认的更多通关对象，检查热门候选");
        break;
      }
      const name = bossName(f),
        score = personalScore(f);
      if (!name || score === null)
        throw new Error("今日挑战记录识别不完整，停止以避免重复挑战");
      if (score > 0) {
        completed.add(name);
        this.log(`${name} · 已有今日通关成绩 ${score}，跳过`);
      }
      await this.map(signal);
    }
    if (gameDay() !== day) throw new Error("已跨过每日刷新时间，请重新执行");
    if (completed.size >= quota) {
      this.log(`今日地域鬼王已完成 ${completed.size}/${quota}，未重复消耗体力`);
      return {
        status: "skipped",
        summary: `今日地域鬼王已有通关成绩 ${completed.size}/${quota}，本次未重复挑战`,
        skipReason: "already-completed",
        goalSatisfied: true,
        evidenceTimestamp: this.now().toISOString(),
        evidenceReference: "onmyoji:realm-raid:verified-daily-scores",
      };
    }
    for (
      let candidate = 0;
      candidate < 3 && completed.size < quota;
      candidate++
    ) {
      if (gameDay() !== day) throw new Error("已跨过每日刷新时间，请重新执行");
      await this.map(signal);
      await this.tap(1695, 78, signal);
      f = await this.waitFor(
        (f) => !!findText(f, /杀数最多|热门/, [1250, 140, 650, 900]),
        signal,
      );
      const hot = findText(f, /^热门$/, [1760, 300, 160, 260]);
      if (hot) await this.text(hot, signal);
      await this.device.swipe(1490, 350, 1490, 1000, signal);
      await this.pause(1000, signal);
      await this.device.swipe(1490, 350, 1490, 1000, signal);
      await this.pause(1000, signal);
      f = await this.shot(signal);
      const rows = f.texts
        .filter(
          (h) =>
            h.score > 0.8 &&
            /^击杀\d+次$/.test(h.text) &&
            h.box[0] > 1250 &&
            h.box[0] < 1450 &&
            h.box[1] > 380 &&
            h.box[1] < 950,
        )
        .sort((a, b) => a.box[1] - b.box[1]);
      if (rows.length !== 3 || !findText(f, /杀数最多/, [1350, 150, 350, 130]))
        throw new Error("热门挑战列表未完整识别，停止");
      await this.tap(1670, rows[candidate].box[1] - 35, signal);
      f = await this.waitFor(isDetail, signal);
      const name = bossName(f),
        score = personalScore(f);
      if (!name) throw new Error("无法确认鬼王名称");
      if (score !== null && score > 0) {
        completed.add(name);
        this.log(`${name} · 已完成，跳过`);
        continue;
      }
      if (
        score === null &&
        !findText(f, /未挑战|未通关|暂无成绩|评分[-—]+/, [950, 610, 770, 140])
      )
        throw new Error("无法确认该鬼王尚未通关，停止以避免重复消耗体力");
      if (completed.has(name)) continue;
      this.log(`${name} · 准备普通 1 级挑战，使用当前阵容`);
      if (gameDay() !== day) throw new Error("已跨过每日刷新时间，请重新执行");
      await this.battleCurrent(signal);
      // The client may return directly to the same detail after settlement.
      // Reopen only from the map; always verify identity and persisted score below.
      const settled = await this.waitFor(
        (f) => isDetail(f) || isMap(f),
        signal,
      );
      if (!isDetail(settled)) await this.tap(1070, 416, signal);
      // Detail controls may appear before the name/score has finished rendering.
      // Only observe while waiting: never retry a battle to resolve missing OCR.
      let verified = false;
      for (let attempt = 0; attempt < 8; attempt++) {
        f = await this.shot(signal);
        if (
          isDetail(f) &&
          bossName(f) === name &&
          (personalScore(f) ?? 0) > 0
        ) {
          verified = true;
          break;
        }
        await this.pause(1200, signal);
      }
      if (!verified)
        throw new Error(
          `胜利后未能确认 ${name} 的今日成绩（当前对象：${bossName(f) ?? "未识别"}，评分：${personalScore(f) ?? "未识别"}），停止后续挑战；可重新执行核对今日记录`,
        );
      completed.add(name);
      newChallenges++;
      this.log(`${name} · 胜利且成绩已写入 (${completed.size}/${quota})`);
    }
    await this.map(signal);
    if (completed.size < quota)
      throw new Error(
        `已确认 ${completed.size}/${quota} 个；热门候选不足或受限，请手动检查其他鬼王`,
      );
    if (gameDay() !== day) throw new Error("已跨过每日刷新时间，请重新执行");
    this.log(`今日地域鬼王完成 ${completed.size}/${quota}`);
    return newChallenges > 0
      ? {
          status: "succeeded",
          summary: `本次新挑战 ${newChallenges} 个地域鬼王，今日通关成绩 ${completed.size}/${quota} 已核对`,
          goalSatisfied: true,
          evidenceTimestamp: this.now().toISOString(),
          evidenceReference: "onmyoji:realm-raid:verified-daily-scores",
        }
      : {
          status: "skipped",
          summary: `今日地域鬼王已有通关成绩 ${completed.size}/${quota}，本次未重复挑战`,
          skipReason: "already-completed",
          goalSatisfied: true,
          evidenceTimestamp: this.now().toISOString(),
          evidenceReference: "onmyoji:realm-raid:verified-daily-scores",
        };
  }
  /**
   * 从庭院/探索页定位胧车入口；入口文字是最强锚点，位置不预设。
   *
   * 找不到时返回 undefined 而不是抛错：胧车属于「逢魔之时」，傍晚才开放
   * （2026-10-15 13:35 实测探索页只有 式神委派/秘闻副本/地域鬼王/妖气探索/英杰试炼/契灵之境）。
   * 日常里某一步抛错会中断整条 lane、剩下的步骤不再执行，所以"今天没开放"必须是可跳过的，
   * 而不是失败——但摘要里要说清是"没看到入口"，不假装已完成。
   */
  private async oborogurumaEntry(signal: AbortSignal): Promise<Frame | undefined> {
    for (let attempt = 0; attempt < 18; attempt++) {
      const f = await this.shot(signal);
      if (
        oborogurumaSettlement(f) ||
        isOborogurumaCard(f) ||
        isOborogurumaActivity(f)
      )
        return f;
      const entry = findText(f, /^胧车$/, [0, 80, 1560, 880]);
      if (entry) {
        await this.text(entry, signal);
        continue;
      }
      // 胧车入口是美术字小标签，OCR 常读不出；用尺度容错的特征匹配兜底。
      const visual =
        (await this.device.matchFeatures?.(
          "oboroguruma-entry.png",
          [0, 550, 620, 530],
          signal,
        )) ?? null;
      if (visual) {
        await this.tap(
          visual.box[0] + visual.box[2] / 2,
          visual.box[1] + visual.box[3] / 2,
          signal,
          1600,
        );
        continue;
      }
      if (isCourtyard(f)) {
        const exploration = findText(f, /^(探索|探)$/, [300, 100, 1200, 650]);
        if (exploration) await this.text(exploration, signal);
        else await this.pause(1200, signal);
        continue;
      }
      // 地域鬼王大地图没有胧车入口，返回上一层继续找。
      if (isMap(f)) {
        await this.tap(75, 60, signal, 1500);
        continue;
      }
      // 已经站在探索页却仍无入口：这是「今天没开放」，不是锚点坏了。
      if (isExploration(f)) return undefined;
      await this.pause(1200, signal);
    }
    return undefined;
  }

  /** 加成面板遮挡卡片；只点四角空白，命中行文本的坐标一律不点。 */
  private async oborogurumaCardAfterBuff(signal: AbortSignal): Promise<Frame> {
    const blanks: [number, number][] = [
      [960, 60],
      [1880, 1000],
      [80, 1000],
      [1880, 90],
    ];
    for (const [x, y] of blanks) {
      await this.tap(x, y, signal, 1200);
      for (let i = 0; i < 2; i++) {
        const f = await this.shot(signal);
        if (isOborogurumaCard(f)) return f;
        if (!isOborogurumaBuffPanel(f)) break;
        await this.pause(800, signal);
      }
      const check = await this.shot(signal);
      if (isOborogurumaCard(check)) return check;
    }
    throw new Error("加成面板未能关闭，停止出发");
  }

  private async oborogurumaReturn(signal: AbortSignal) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const f = await this.shot(signal);
      if (isCourtyard(f) || isExploration(f) || isMap(f)) return;
      await this.tap(75, 60, signal, 1200);
    }
    throw new Error("胧车已出发但未能返回已知页面，请手动核对当前画面");
  }

  async oboroguruma(signal: AbortSignal): Promise<SkillResult> {
    try {
      return await this.oborogurumaInner(signal);
    } catch (error) {
      // 失败时附带画面 OCR 摘要，便于核对锚点失效的具体原因。
      const probe = await this.shot(signal).catch(() => undefined);
      const digest = probe?.texts
        .filter((h) => h.score >= 0.55)
        .slice(0, 24)
        .map((h) => `${h.text}@${Math.round(h.box[0])},${Math.round(h.box[1])}`)
        .join(" / ");
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        digest ? `${detail}；画面文字：${digest}` : detail,
      );
    }
  }

  private async oborogurumaInner(signal: AbortSignal): Promise<SkillResult> {
    this.beginEffects("oboroguruma");
    let f = await this.shot(signal);
    // 结算页/卡片页也算「已在胧车相关页面」：先认出来，不要先去庭院——
    // 2026-10-15 实机就是先硬去庭院，被结算页挡住后直接失败。
    if (
      oborogurumaSettlement(f) ||
      isOborogurumaCard(f) ||
      isOborogurumaActivity(f)
    ) {
      this.log("已在胧车相关页面，跳过庭院导航");
    } else {
      await this.courtyard(signal);
      const entry = await this.oborogurumaEntry(signal);
      if (!entry)
        return {
          status: "skipped",
          // 协议规定 not-open 不允许配 goalSatisfied: true —— 什么都没做就不能说目标达成。
          skipReason: "not-open",
          goalSatisfied: false,
          evidenceTimestamp: this.now().toISOString(),
          evidenceReference: "onmyoji:oboroguruma:entry-absent",
          ...this.recordedEffects(),
          summary:
            "探索页没有胧车入口（逢魔之时未开放，或界面已变更）；本次未开始挂机，未假装完成",
        };
      f = entry;
    }
    if (oborogurumaSettlement(f)) {
      const confirm = oborogurumaSettlementConfirm(f)!;
      await this.text(confirm, signal);
      this.log("上一轮胧车挂机已结算并确认，未重复出发");
      await this.oborogurumaReturn(signal);
      return {
        status: "skipped",
        skipReason: "already-completed",
        goalSatisfied: true,
        evidenceTimestamp: this.now().toISOString(),
        evidenceReference: "onmyoji:oboroguruma:observed-settlement",
        summary: "胧车挂机上一轮已结束，已确认结算页，本次未重复出发",
      };
    }
    if (!isOborogurumaCard(f) && isOborogurumaActivity(f)) {
      this.log("已进入胧车探索页，点击御魂关卡标记打开任务卡片");
      const soulMarker = findText(f, /^御魂$/, [600, 350, 800, 320]);
      if (soulMarker) await this.text(soulMarker, signal);
      else await this.tap(980, 545, signal, 1600);
    }
    f = await this.waitFor(isOborogurumaCard, signal, 8);
    if (oborogurumaAutoEquipDialog(f)) {
      const confirm = findText(f, /^确定$/, [1020, 560, 420, 220])!;
      this.submittingEffect();
      await this.text(confirm, signal);
      this.confirmedEffect(
        "oboroguruma-equip",
        "已在自动上阵通关式神并佩戴御魂的提示上确认确定",
      );
      f = await this.waitFor(isOborogurumaCard, signal, 8);
    }
    const next = await this.cardNextStep(f, signal);
    if (next) {
      await this.tap(
        next.box[0] + next.box[2] / 2,
        next.box[1] + next.box[3] / 2,
        signal,
        1600,
      );
      // 用户实测：自动上阵提示出现在点下一步之后（而非卡片打开时）。
      f = await this.waitFor(
        (frame) =>
          isOborogurumaCard(frame) || !!oborogurumaAutoEquipDialog(frame),
        signal,
        8,
      );
      if (oborogurumaAutoEquipDialog(f)) {
        const confirm = findText(f, /^确定$/, [1020, 560, 420, 220])!;
        this.submittingEffect();
        await this.text(confirm, signal);
        this.confirmedEffect(
          "oboroguruma-equip",
          "已在自动上阵通关式神并佩戴御魂的提示上确认确定",
        );
        f = await this.waitFor(isOborogurumaCard, signal, 8);
      }
    }
    const buffButton = oborogurumaBuffButton(f);
    if (!buffButton)
      throw new Error("胧车卡片未找到加成入口，停止出发；请核对卡片页");
    await this.text(buffButton, signal);
    f = await this.waitFor(
      (frame) => isOborogurumaBuffPanel(frame) || !!oborogurumaDepart(frame),
      signal,
      6,
    );
    if (isOborogurumaBuffPanel(f)) {
      const row = oborogurumaBuffRow(f);
      const chip = row ? oborogurumaBuffChip(f, row) : undefined;
      if (!row || !chip)
        throw new Error("加成面板未找到八岐大蛇御魂加成行，停止出发");
      this.submittingEffect();
      await this.tap(
        chip.box[0] + chip.box[2] + 24,
        chip.box[1] + chip.box[3] / 2,
        signal,
      );
      this.confirmedEffect(
        "oboroguruma-equip",
        "已点击八岐大蛇御魂加成行的使用按钮",
      );
      f = await this.oborogurumaCardAfterBuff(signal);
    }
    // 次数加倍按钮（⇈）：2026-10-15 实机发现模板匹配会偏十几像素、点不中，次数停在 1/60。
    // 现在以**次数文本**为锚点推位置（⇈ 就在次数右侧同一行），模板只作兜底。
    const countBefore = oborogurumaCount(f);
    let maxX: number | undefined;
    let maxY: number | undefined;
    if (countBefore) {
      maxX = countBefore.box[0] + countBefore.box[2] + 175;
      maxY = countBefore.box[1] + countBefore.box[3] / 2;
    } else {
      const max =
        (await this.device.matchTemplate(
          "oboroguruma-max.png",
          [1500, 760, 420, 320],
          0.8,
          signal,
        )) ??
        (await this.device.matchFeatures?.(
          "oboroguruma-max.png",
          [1500, 760, 420, 320],
          signal,
        ));
      if (max) {
        maxX = max.box[0] + max.box[2] / 2;
        maxY = max.box[1] + max.box[3] / 2;
      }
    }
    if (maxX === undefined || maxY === undefined)
      throw new Error("未找到次数加倍按钮（双箭头），停止出发；请核对卡片布局");
    this.log(
      `次数加倍按钮定位 (${Math.round(maxX)},${Math.round(maxY)})（${countBefore ? "按次数文本推算" : "按模板兜底"}）`,
    );
    await this.tap(maxX, maxY, signal);
    f = await this.waitFor(isOborogurumaCard, signal, 6);
    const count = oborogurumaCount(f);
    if (!count) throw new Error("无法读取胧车挂机次数，停止出发");
    if (count.done < 1)
      // 今天没有可用的挂机次数：这是"没得做"，不是锚点坏了，按跳过如实报告。
      return {
        status: "skipped",
        skipReason: "unavailable",
        goalSatisfied: false,
        evidenceTimestamp: this.now().toISOString(),
        evidenceReference: "onmyoji:oboroguruma:no-runs-available",
        ...this.recordedEffects(),
        summary: `胧车挂机次数为 ${count.done}/${count.total}，今天没有可出发的次数；未出发`,
      };
    // 2026-10-15 实机：点了加倍按钮也只拿到 1/60（上限 60，资源足够），
    // 所以"必须等于上限"会把正常状态当成异常、白白停一天。改为按实际次数出发：
    // 有多少挂多少（≥1），把次数如实写进结果，不自动购买或补充资源。
    if (count.done !== count.total)
      this.log(
        `次数加倍后为 ${count.done}/${count.total}（未到上限，按实际次数出发）`,
      );
    // 出发同为金色美术字，OCR 常缺失；此时以同款齿轮模板（下一步按钮）在
    // 卡片右下区域定位，绝不盲点。
    const depart =
      oborogurumaDepart(f) ??
      (await this.device.matchTemplate(
        "oboroguruma-next.png",
        [1380, 760, 540, 320],
        0.8,
        signal,
      ));
    if (!depart) throw new Error("卡片未显示出发按钮，停止");
    this.log(
      `卡片核对完成：${count.done}/${count.total} 次，御魂配置与八岐大蛇加成已确认，出发`,
    );
    this.submittingEffect();
    await this.tap(
      depart.box[0] + depart.box[2] / 2,
      depart.box[1] + depart.box[3] / 2,
      signal,
    );
    // 出发点击后卡片必须关闭；未关闭一律停止，绝不重复点击出发。
    // 出发按钮 OCR 不可靠时用齿轮模板是否存在来判断卡片是否仍在。
    let departed = false;
    let declinedBuff = false;
    for (let i = 0; i < 6; i++) {
      const after = await this.shot(signal);
      // 2026-10-15 实机：点「出发」之后游戏会追问「当前没有使用御魂掉落加成，是否打开加成？」。
      // 注意这条询问在画面上是**两行**文字（「…是否」/「为阴阳师大人打开加成？」），
      // 所以按第二行的「打开加成」识别，不能要求两行在同一命中里。
      const offer = findText(after, /打开加成/, [400, 350, 1100, 220]);
      if (offer) {
        const decline = findText(after, /^取消$/, [600, 560, 420, 170]);
        if (!decline)
          throw new Error("出发后出现加成询问，但未找到「取消」，停止；不代玩家买加成");
        if (!declinedBuff) {
          await this.text(decline, signal);
          declinedBuff = true;
          this.log("已拒绝「打开御魂掉落加成」询问（不代玩家买加成），挂机照常开始");
        }
        await this.pause(1200, signal);
        continue;
      }
      const stillOpen =
        oborogurumaDepart(after) ||
        oborogurumaAutoEquipDialog(after) ||
        (isOborogurumaCard(after) &&
          !!(await this.device.matchTemplate(
            "oboroguruma-next.png",
            [1380, 760, 540, 320],
            0.8,
            signal,
          )));
      if (!stillOpen) {
        departed = true;
        break;
      }
      await this.pause(1200, signal);
    }
    if (!departed)
      throw new Error("点击出发后任务卡未关闭，停止；不会重复点击出发");
    this.confirmedEffect(
      "oboroguruma-start",
      `已出发胧车挂机，次数 ${count.done}/${count.total}${declinedBuff ? "；已拒绝加成加购询问" : ""}`,
    );
    await this.oborogurumaReturn(signal);
    this.completedEffects();
    return {
      status: "succeeded",
      goalSatisfied: true,
      evidenceTimestamp: this.now().toISOString(),
      evidenceReference: "onmyoji:oboroguruma:started-available-count",
      ...this.recordedEffects(),
      summary: `胧车挂机已出发（${count.done}/${count.total} 次${count.done !== count.total ? "，未到上限按实际次数" : ""}），御魂配置与八岐大蛇加成已核对${declinedBuff ? "；已拒绝加成加购" : ""}`,
    };
  }

  /**
   * 难度页签（普/极）与等级徽标都是美术字：`findText` 只能读到其中一部分。
   * 2026-10-15 鸟巢实测：普通难度下页签显示「极」，但 0.3–0.7 全阈值都读不出该字形，
   * 旧代码于是直接放弃挑战（当天 2/3 半途而废）。按 `cardNextStep` 的同一惯例改用
   * 模板兜底，OCR 仍是首选，模板只补它读不到的字。
   */
  private async difficultyBox(
    f: Frame,
    template: string,
    pattern: RegExp,
    roi: Rect,
    signal: AbortSignal,
  ): Promise<Rect | undefined> {
    const hit = findText(f, pattern, roi);
    if (hit) return hit.box;
    return (
      (await this.device.matchTemplate(template, roi, 0.8, signal))?.box ??
      undefined
    );
  }
  private async tapBox(box: Rect, signal: AbortSignal) {
    await this.tap(box[0] + box[2] / 2, box[1] + box[3] / 2, signal);
  }
  /** Also used by the supervised acceptance harness, never exposed as a UI skill. */
  async battleCurrent(signal: AbortSignal) {
    let f = await this.shot(signal);
    if (!isDetail(f)) throw new Error("不在鬼王详情，禁止挑战");
    const tabRoi: Rect = [380, 150, 120, 100];
    const normalSwitch = await this.difficultyBox(
      f,
      "difficulty-normal.png",
      /^普$/,
      tabRoi,
      signal,
    );
    if (normalSwitch) {
      await this.tapBox(normalSwitch, signal);
      f = await this.waitFor(isDetail, signal);
    }
    if (
      !(await this.difficultyBox(
        f,
        "difficulty-extreme.png",
        /^极$/,
        tabRoi,
        signal,
      ))
    )
      throw new Error("无法确认普通难度模式，停止");
    // 鬼王等级是**账号自己的设置**（lane-a 是 1 级、lane-b 是 60 级）：不替玩家改，只读出来写进结果。
    // 2026-10-15：旧代码先点一次减号、再硬要求读数等于 1，既擅自动了玩家的设置，
    // 又在 lane-b（等级 60）上直接卡死整条日常。等级只影响评分，不影响每日胜场。
    const levelRoi: Rect = [490, 280, 53, 61];
    const levelFrame = await this.device.observe(signal, levelRoi, true);
    const levelHit = findText(levelFrame, /^\d{1,3}$/, levelRoi);
    const levelLabel = levelHit?.text ?? "未识别（美术字）";
    f = await this.shot(signal);
    if (!isDetail(f)) throw new Error("挑战前画面发生变化");
    this.log(`普通难度已确认（鬼王等级 ${levelLabel}），开始挑战`);
    await this.text(findText(f, /^挑战$/, [1600, 730, 260, 220])!, signal);
    f = await this.waitFor(
      (f) => !!findText(f, /准备|不满足|不足|达到上限|无法挑战/),
      signal,
      12,
    );
    const issue = findText(f, /不满足|不足|达到上限|无法挑战/);
    if (issue) throw new Error(`游戏拒绝挑战：${issue.text}`);
    const ready = findText(f, /^准备$/, [1580, 650, 340, 430]);
    if (!ready) throw new Error("未能确认准备按钮");
    await this.pause(3500, signal);
    await this.text(ready, signal);
    this.log("已进入战斗，等待自动战斗结果");
    let won = false;
    for (let i = 0; i < 100; i++) {
      await this.pause(1800, signal);
      f = await this.shot(signal);
      if (findText(f, /失败|战败/))
        throw new Error("战斗失败，请调整当前阵容后再试");
      if (isVictory(f)) {
        won = true;
        break;
      }
      const manual = findText(f, /^手动$/, [0, 850, 220, 230]);
      if (manual) await this.text(manual, signal);
    }
    if (!won)
      throw new Error("战斗超时，已停止后续操作，请检查阵容或手动战斗状态");
    this.log("已识别战斗胜利，结算奖励");
    for (let i = 0; i < 8; i++) {
      f = await this.shot(signal);
      if (isDetail(f) || isMap(f)) return;
      if (findText(f, /胜利|本次评分|点击.*继续|获得奖励/)) {
        await this.tap(955, 1028, signal, 1500);
        continue;
      }
      await this.pause(1500, signal);
    }
    throw new Error("胜利后结算界面未关闭，请在模拟器处理后重新执行");
  }
}
