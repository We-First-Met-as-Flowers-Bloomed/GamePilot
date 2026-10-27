/** Observations from one native task; none of these fields asserts reward quantities. */
export interface ArknightsStatistics {
  version: 1;
  infrastructure?: {
    reception: {
      /** Paired native ProcessTask callbacks; some nodes are detectors, not actions. */
      observedNodes: ReceptionObservationNode[];
      errorObserved?: true;
    };
  };
  fight?: {
    /** Highest native cumulative report, which may precede the last settlement. */
    completedRunsObserved?: number;
    firstSanity?: number;
    latestSanity?: number;
  };
  mall?: {
    purchaseConfirmations: number;
    creditCollected: boolean;
    /** Native discount-only stopping observation, not proof that no discounts exist. */
    discountOnlyStoppedAtCredit?: number;
    /** A shopping probe may fail without failing the enclosing Mall chain. */
    shoppingErrorObserved?: true;
    /** Fresh matching shop frames after the native task, never inferred from a callback. */
    finalCredit?: number;
  };
  award?: {
    claimActions: number;
    mail: "unobserved" | "empty" | "claim-confirmed";
  };
}

export const RECEPTION_OBSERVATION_NODES = [
  "InfrastReceptionMessageBoard-Received",
  "InfrastReceptionMessageBoard-CouldReceive",
  "GetSelfClue",
  "InfrastClueQuickInsert",
  "InfrastClueQuickSendDuplicates",
  "EndOfClueExchange",
  "EndOfClueExchangeClose",
] as const;
export type ReceptionObservationNode =
  (typeof RECEPTION_OBSERVATION_NODES)[number];

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const count = (value: unknown, max = 1_000_000): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max;
const keys = (value: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));

export function validArknightsStatistics(
  input: unknown,
  taskType: string,
): input is ArknightsStatistics {
  const value = object(input);
  const branch = {
    Fight: "fight",
    Mall: "mall",
    Award: "award",
    Infrast: "infrastructure",
  }[taskType];
  if (
    !value ||
    value.version !== 1 ||
    !branch ||
    !keys(value, ["version", branch])
  )
    return false;
  const detail = object(value[branch]);
  if (!detail) return false;
  if (branch === "infrastructure") {
    const reception = object(detail.reception);
    return (
      !!reception &&
      keys(detail, ["reception"]) &&
      keys(reception, ["observedNodes", "errorObserved"]) &&
      Array.isArray(reception.observedNodes) &&
      reception.observedNodes.length <= RECEPTION_OBSERVATION_NODES.length &&
      reception.observedNodes.every((node) =>
        RECEPTION_OBSERVATION_NODES.includes(node),
      ) &&
      new Set(reception.observedNodes).size ===
        reception.observedNodes.length &&
      (reception.errorObserved === undefined ||
        reception.errorObserved === true) &&
      (reception.observedNodes.length > 0 || reception.errorObserved === true)
    );
  }
  if (branch === "fight") {
    return (
      keys(detail, ["completedRunsObserved", "firstSanity", "latestSanity"]) &&
      (detail.completedRunsObserved !== undefined ||
        detail.firstSanity !== undefined) &&
      (detail.completedRunsObserved === undefined ||
        count(detail.completedRunsObserved)) &&
      ((detail.firstSanity === undefined &&
        detail.latestSanity === undefined) ||
        (count(detail.firstSanity, 9999) && count(detail.latestSanity, 9999)))
    );
  }
  if (branch === "mall")
    return (
      keys(detail, [
        "purchaseConfirmations",
        "creditCollected",
        "discountOnlyStoppedAtCredit",
        "shoppingErrorObserved",
        "finalCredit",
      ]) &&
      count(detail.purchaseConfirmations) &&
      typeof detail.creditCollected === "boolean" &&
      (detail.discountOnlyStoppedAtCredit === undefined ||
        count(detail.discountOnlyStoppedAtCredit)) &&
      (detail.shoppingErrorObserved === undefined ||
        detail.shoppingErrorObserved === true) &&
      (detail.finalCredit === undefined || count(detail.finalCredit))
    );
  return (
    keys(detail, ["claimActions", "mail"]) &&
    count(detail.claimActions) &&
    typeof detail.mail === "string" &&
    ["unobserved", "empty", "claim-confirmed"].includes(detail.mail)
  );
}

const mallNodes = [
  "CreditShop-BuyIt",
  "CreditShop-Bought",
  "CreditShop-NoMoney",
  "CollectCredit",
];
const awardNodes = [
  "ReceiveAward",
  "ReceiveMail",
  "ReceivedAllMail",
  "MailWithoutAward",
];

/** Caller enforces task identity and lifetime. Pair consumption rejects repeated completion
 * callbacks; it does not promise deduplication of a replayed entire native event stream. */
export class ArknightsStatisticsCollector {
  private reception: NonNullable<
    ArknightsStatistics["infrastructure"]
  >["reception"] = { observedNodes: [] };
  private fight: NonNullable<ArknightsStatistics["fight"]> = {};
  private mall: NonNullable<ArknightsStatistics["mall"]> = {
    purchaseConfirmations: 0,
    creditCollected: false,
  };
  private award: NonNullable<ArknightsStatistics["award"]> = {
    claimActions: 0,
    mail: "unobserved",
  };
  private seenBranch = false;
  private pending = new Map<string, number>();
  private awaitingPurchase = false;
  private awaitingMail = false;
  private highestClaimCounter = 0;
  constructor(private taskType: string) {}

  accept(code: number, value: Record<string, unknown>) {
    const details = object(value.details);
    if (this.taskType === "Infrast") {
      if (code === 20000) {
        this.pending.clear();
        if (value.subtask === "InfrastReceptionTask")
          this.reception.errorObserved = true;
        return;
      }
      if (
        value.subtask !== "ProcessTask" ||
        !details ||
        !RECEPTION_OBSERVATION_NODES.includes(
          details.task as ReceptionObservationNode,
        ) ||
        !count(details.exec_times) ||
        details.exec_times < 1
      )
        return;
      const task = details.task as ReceptionObservationNode;
      if (code === 20001) this.pending.set(task, details.exec_times);
      else if (code === 20002) {
        const pending = this.pending.get(task);
        this.pending.delete(task);
        if (
          pending === details.exec_times &&
          !this.reception.observedNodes.includes(task)
        )
          this.reception.observedNodes.push(task);
      }
      return;
    }
    if (code === 20003 && this.taskType === "Fight" && details) {
      if (value.what === "FightTimes" && count(details.times_finished))
        this.fight.completedRunsObserved = Math.max(
          this.fight.completedRunsObserved ?? 0,
          details.times_finished,
        );
      else if (
        value.what === "SanityBeforeStage" &&
        count(details.current_sanity, 9999)
      ) {
        this.fight.firstSanity ??= details.current_sanity;
        this.fight.latestSanity = details.current_sanity;
      }
      return;
    }
    if (this.taskType !== "Mall" && this.taskType !== "Award") return;
    if (code === 20000) {
      if (this.taskType === "Mall" && value.subtask === "CreditShoppingTask") {
        this.mall.shoppingErrorObserved = true;
        this.seenBranch = true;
      }
      this.pending.clear();
      this.awaitingPurchase = false;
      this.awaitingMail = false;
      return;
    }
    if (
      this.taskType === "Mall" &&
      code === 20003 &&
      value.what === "CreditFullOnlyBuyDiscount" &&
      details &&
      count(details.credit)
    ) {
      this.seenBranch = true;
      this.mall.discountOnlyStoppedAtCredit = details.credit as number;
    }
    if (
      value.subtask !== "ProcessTask" ||
      !details ||
      typeof details.task !== "string" ||
      !count(details.exec_times) ||
      details.exec_times < 1
    )
      return;
    const task = details.task;
    if (!(this.taskType === "Mall" ? mallNodes : awardNodes).includes(task))
      return;
    if (code === 20001) {
      this.seenBranch = true;
      this.pending.set(task, details.exec_times);
      if (task === "CreditShop-BuyIt") this.awaitingPurchase = false;
      if (task === "ReceiveMail") this.awaitingMail = false;
      return;
    }
    if (code !== 20002) return;
    const expected = this.pending.get(task);
    this.pending.delete(task);
    if (expected !== details.exec_times) return;
    if (task === "CreditShop-BuyIt") this.awaitingPurchase = true;
    else if (task === "CreditShop-Bought" && this.awaitingPurchase) {
      this.mall.purchaseConfirmations = Math.min(
        1_000_000,
        this.mall.purchaseConfirmations + 1,
      );
      this.awaitingPurchase = false;
    } else if (task === "CreditShop-NoMoney") this.awaitingPurchase = false;
    else if (task === "CollectCredit") this.mall.creditCollected = true;
    else if (
      task === "ReceiveAward" &&
      details.exec_times > this.highestClaimCounter
    ) {
      this.award.claimActions++;
      this.highestClaimCounter = details.exec_times;
    } else if (task === "ReceiveMail") this.awaitingMail = true;
    else if (task === "ReceivedAllMail" && this.awaitingMail) {
      this.award.mail = "claim-confirmed";
      this.awaitingMail = false;
    } else if (
      task === "MailWithoutAward" &&
      this.award.mail !== "claim-confirmed"
    )
      this.award.mail = "empty";
  }

  finish(nativeConfirmed: boolean): ArknightsStatistics | undefined {
    if (this.taskType === "Infrast")
      return this.reception.observedNodes.length || this.reception.errorObserved
        ? {
            version: 1,
            infrastructure: { reception: structuredClone(this.reception) },
          }
        : undefined;
    if (this.taskType === "Fight")
      return Object.keys(this.fight).length
        ? { version: 1, fight: { ...this.fight } }
        : undefined;
    // Complete observation of a supported chain can establish zero observed actions,
    // never that the game had no available purchase/reward or that options were enabled.
    if (!this.seenBranch && !nativeConfirmed) return undefined;
    if (this.taskType === "Mall") return { version: 1, mall: { ...this.mall } };
    if (this.taskType === "Award")
      return { version: 1, award: { ...this.award } };
    return undefined;
  }
}
