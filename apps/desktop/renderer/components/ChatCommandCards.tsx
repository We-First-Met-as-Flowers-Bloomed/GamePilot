import { useEffect, useRef, useState } from "react";
import { CircleCheck, CircleX, Clock3, ListChecks, Pause } from "lucide-react";
import type { DesktopAPI } from "../../../../packages/protocol";
import type { ChatCommandView } from "../../../../packages/protocol/chat-commands";
import type { ExecutionRecord } from "../../../../packages/protocol/execution";
import type { PauseAfterStepReceipt } from "../../../../packages/protocol/step-control";
import type { AgentEvent } from "../../../../packages/protocol/agent-events";
import type { ChatTurn } from "../../../../packages/protocol/agent-chat";
import { AgentRunTrace } from "./AgentRunTrace";
import { useDistinctValue } from "../hooks/useDistinctValue";
import { watchSnapshot } from "../hooks/watchSnapshot";

export interface ChatHostAction {
  key: number;
  sessionId: string;
  kind: "saved-daily" | "continue" | "pause";
  text: string;
  /** The host resolves this exact current turn; never translate it into arbitrary text. */
  intentTarget?: { turnId: string; requestId: string };
}
const labels = {
  running: "运行中",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
  unknown: "结果未知",
};
export async function confirmReviewedCommand(
  api: Pick<DesktopAPI, "confirmChatCommand">,
  sessionId: string,
  view: ChatCommandView,
  acknowledgePartial = false,
) {
  if (
    view.sessionId !== sessionId ||
    view.status !== "review" ||
    !Number.isFinite(Date.parse(view.expiresAt)) ||
    Date.parse(view.expiresAt) <= Date.now()
  )
    throw Error("指令不属于当前会话、已受理或已过期，请重新检查");
  if (view.needsAcknowledgement && !acknowledgePartial)
    throw Error("请先核对失败步骤的部分执行情况");
  return api.confirmChatCommand({
    sessionId,
    reviewId: view.reviewId,
    revision: view.revision,
    ...(view.needsAcknowledgement && acknowledgePartial
      ? { acknowledgePartial: true }
      : {}),
  });
}
function merge(previous: ChatCommandView[], values: ChatCommandView[]) {
  const entries = new Map(previous.map((view) => [view.reviewId, view]));
  const rank = { review: 0, unknown: 1, blocked: 2, submitted: 2 };
  for (const view of values) {
    const prior = entries.get(view.reviewId);
    if (
      !prior ||
      view.revision > prior.revision ||
      (view.revision === prior.revision &&
        rank[view.status] >= rank[prior.status])
    )
      entries.set(view.reviewId, view);
  }
  return [...entries.values()]
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .slice(-16);
}

export function ChatCommandReviewCard({
  view,
  sessionId,
  pending,
  onConfirm,
  onOpenExecution,
  api,
  active = false,
  originPrompt,
}: {
  view: ChatCommandView;
  sessionId?: string;
  pending: boolean;
  onConfirm: (view: ChatCommandView, acknowledgePartial?: boolean) => void;
  onOpenExecution: (id: string) => void;
  api?: DesktopAPI;
  active?: boolean;
  originPrompt?: string;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const card = useRef<HTMLElement>(null);
  const unchanged = useDistinctValue();
  useEffect(() => {
    if (view.status === "review")
      card.current?.scrollIntoView({ block: "nearest" });
  }, [view.reviewId]);
  useEffect(() => setAcknowledged(false), [view.reviewId, view.revision]);
  const expired =
    !Number.isFinite(Date.parse(view.expiresAt)) ||
    Date.parse(view.expiresAt) <= Date.now();
  const canConfirm =
    view.sessionId === sessionId && view.status === "review" && !expired;
  const status = {
    review: "等待确认",
    submitted: "调度器已受理",
    blocked: "未启动",
    unknown: "受理结果未确认",
  }[view.status];
  return (
    <article
      ref={card}
      className="chat-command-card"
      data-review-id={view.reviewId}
      data-status={view.status}
      data-intent-turn-id={view.origin?.turnId}
    >
      <header>
        <ListChecks size={16} />
        <strong>
          {view.kind === "continue" ? "原请求续跑检查" : "保存日常执行检查"}
        </strong>
        <span>{status}</span>
      </header>
      {view.origin && (
        <p className="chat-command-intent-reference">
          {originPrompt ?? "来自本会话的日常需求"}
          <small>宿主执行检查</small>
        </p>
      )}
      <p className="helper">
        {view.kind === "continue"
          ? "只继续宿主检查的原请求剩余步骤；已完成步骤保留，未知提交先核对。"
          : "使用已保存账号与本时段任务开关，资源上限按以下宿主冻结清单核对。"}
      </p>
      {view.parentId && (
        <p className="chat-command-reference">
          原请求 <code>{view.parentId}</code>
        </p>
      )}
      <div className="chat-command-plans">
        {view.summary.map((lane, i) => (
          <section key={`${lane.laneName}-${i}`}>
            <strong>{lane.laneName}</strong>
            {lane.games.map((game) => (
              <div key={game.gameId}>
                <h4>{game.title}</h4>
                <ol>
                  {game.steps.map((step, index) => (
                    <li key={index}>{step}</li>
                  ))}
                </ol>
              </div>
            ))}
          </section>
        ))}
      </div>
      {view.message && (
        <p className="helper" role="status">
          {view.message}
        </p>
      )}
      {expired && view.status === "review" && (
        <p className="helper">检查已过期，请重新发送指令检查。</p>
      )}
      {view.status === "unknown" && (
        <p className="helper">请核对原执行回执，不要重发启动指令。</p>
      )}
      {canConfirm && view.needsAcknowledgement && (
        <label className="chat-command-acknowledgement">
          <input
            type="checkbox"
            checked={acknowledged}
            disabled={pending}
            onChange={(event) => setAcknowledged(event.target.checked)}
          />
          <span>我已核对失败步骤的部分执行情况</span>
        </label>
      )}
      {canConfirm && (
        <div className="chat-command-actions">
          <button
            type="button"
            className="button primary"
            disabled={
              pending || Boolean(view.needsAcknowledgement && !acknowledged)
            }
            onClick={() => onConfirm(view, acknowledged)}
          >
            {pending
              ? "正在核对受理回执…"
              : view.kind === "continue"
                ? "确认续跑原请求"
                : "确认运行保存日常"}
          </button>
          <small>确认时再次核对配置与原请求版本</small>
        </div>
      )}
      {view.receipt && (
        <div className="chat-command-actions">
          {view.receipt.requestIds.map((id) => (
            <button
              className="text-button"
              type="button"
              key={id}
              onClick={() => onOpenExecution(id)}
            >
              查看执行回执 <code>{id}</code>
            </button>
          ))}
        </div>
      )}
      <AgentRunTrace api={api} requestId={view.reviewId} active={active} />
    </article>
  );
}

export function ChatCommandRequestPicker({
  kind,
  requests,
  selectedId,
  pending,
  onSelect,
  onReview,
}: {
  kind: "continue" | "pause";
  requests: Pick<ExecutionRecord, "id" | "status" | "startedAt" | "laneId">[];
  selectedId: string;
  pending: boolean;
  onSelect: (id: string) => void;
  onReview: () => void;
}) {
  const pause = kind === "pause";
  return (
    <section
      className="chat-command-picker"
      aria-label={pause ? "选择暂停目标" : "选择原请求续跑"}
    >
      <header>
        {pause ? <Pause size={15} /> : <ListChecks size={15} />}
        <strong>{pause ? "当前步骤结束后暂停" : "继续原失败请求"}</strong>
      </header>
      <p className="helper">
        {pause
          ? "选择正在运行的精确请求，保留当前步骤结果并在步骤边界暂停后续项。"
          : "选择原失败请求，先检查默认剩余步骤；已完成步骤保留，不创建一份重跑日常。"}
      </p>
      <label>
        <span>{pause ? "运行中的请求" : "原请求"}</span>
        <select
          aria-label={pause ? "选择暂停请求" : "选择需要续跑的原请求"}
          value={selectedId}
          disabled={pending}
          onChange={(event) => onSelect(event.target.value)}
        >
          <option value="">
            {pause ? "请选择运行中的请求" : "请选择原失败请求"}
          </option>
          {requests.map((request) => (
            <option key={request.id} value={request.id}>
              {request.laneId ?? "单任务"} · {labels[request.status]} ·{" "}
              {new Date(request.startedAt).toLocaleString("zh-CN", {
                hour12: false,
              })}{" "}
              · {request.id}
            </option>
          ))}
        </select>
      </label>
      {!requests.length && (
        <p className="helper">
          {pause
            ? "当前没有记录为运行中的请求，请核对执行状态。"
            : "当前没有可选的原失败请求，请查看执行记录。"}
        </p>
      )}
      <button
        type="button"
        className="button"
        disabled={
          pending ||
          !selectedId ||
          !requests.some((request) => request.id === selectedId)
        }
        onClick={onReview}
      >
        {pending
          ? "正在检查…"
          : pause
            ? "请求步骤结束后暂停"
            : "检查原请求剩余步骤"}
      </button>
    </section>
  );
}
export function ChatPauseReceipt({
  receipt,
}: {
  receipt: PauseAfterStepReceipt;
}) {
  const applied = receipt.status === "applied";
  return (
    <div
      className="chat-pause-receipt"
      role="status"
      data-pause-status={receipt.status}
    >
      {applied ? <CircleCheck size={15} /> : <Clock3 size={15} />}
      <div>
        <strong>
          {applied ? "已在步骤边界暂停" : "已登记暂停请求，等待当前步骤结束"}
        </strong>
        <p>
          {applied
            ? "后续步骤暂停，当前步骤结果以原执行账本为准。"
            : "尚未确认暂停生效，请继续查看原执行状态。"}
        </p>
        <code>{receipt.runId}</code>
      </div>
    </div>
  );
}

export function pauseAppliedByEvent(
  receipt: PauseAfterStepReceipt,
  requestId: string,
  event: AgentEvent,
) {
  return (
    event.requestId === requestId &&
    event.runId === receipt.runId &&
    event.kind === "correction" &&
    event.status === "succeeded"
  );
}

export default function ChatCommandCards({
  api,
  sessionId,
  action,
  requests,
  onOpenExecution,
  turns = [],
}: {
  api?: DesktopAPI;
  sessionId?: string;
  action?: ChatHostAction;
  requests: ExecutionRecord[];
  onOpenExecution: (id: string) => void;
  turns?: ChatTurn[];
}) {
  const [reviews, setReviews] = useState<ChatCommandView[]>([]),
    [picker, setPicker] = useState<"continue" | "pause">(),
    [selectedId, setSelectedId] = useState(""),
    [pending, setPending] = useState(false),
    [error, setError] = useState(""),
    [pause, setPause] = useState<PauseAfterStepReceipt>();
  const [pauseRequestId, setPauseRequestId] = useState<string>();
  const [readError, setReadError] = useState("");
  const scope = useRef(0),
    inFlight = useRef(false),
    handled = useRef(0);
  const unchanged = useDistinctValue();
  const supported =
    api &&
    typeof api.chatCommands === "function" &&
    typeof api.reviewChatCommand === "function" &&
    typeof api.confirmChatCommand === "function";
  useEffect(() => {
    const epoch = ++scope.current;
    setReviews([]);
    inFlight.current = false;
    setPending(false);
    setPicker(undefined);
    setSelectedId("");
    setError("");
    setReadError("");
    setPause(undefined);
    setPauseRequestId(undefined);
    if (!supported || !sessionId) return;
    const close = watchSnapshot({
      read: () => api.chatCommands(sessionId),
      subscribe: (refresh) =>
        api.onAgentEvent?.((event) => {
          if (event.kind === "command" && event.sessionId === sessionId)
            refresh();
        }) ?? (() => {}),
      accept: (values) => {
        if (scope.current === epoch) setReadError("");
        if (scope.current === epoch && unchanged([sessionId, values]))
          setReviews((previous) =>
            merge(
              previous,
              values.filter((view) => view.sessionId === sessionId),
            ),
          );
      },
      error: () => {
        if (scope.current === epoch)
          setReadError("暂时无法读取宿主指令，请核对执行回执。不要重复启动。");
      },
    });
    return () => {
      scope.current++;
      close();
    };
  }, [api, sessionId]);
  useEffect(() => {
    if (!api || !pause || pause.status !== "queued" || !pauseRequestId) return;
    let closed = false;
    const accept = (event: AgentEvent) => {
      if (!closed && pauseAppliedByEvent(pause, pauseRequestId, event))
        setPause((previous) =>
          previous?.runId === pause.runId
            ? { ...previous, status: "applied" }
            : previous,
        );
    };
    const unsubscribe =
      typeof api.onAgentEvent === "function"
        ? api.onAgentEvent(accept)
        : undefined;
    // Subscribe first, then replay: an applied correction can arrive before the IPC receipt.
    const replay = async () => {
      if (typeof api.agentEvents !== "function") return;
      let cursor = 0;
      try {
        for (let pageNumber = 0; pageNumber < 32 && !closed; pageNumber++) {
          const page = await api.agentEvents({
            requestId: pauseRequestId,
            afterSeq: cursor,
            limit: 128,
          });
          if (closed || page.gap || page.error) return;
          page.events.forEach(accept);
          if (!page.hasMore || page.cursor <= cursor) return;
          cursor = page.cursor;
        }
      } catch {
        /* Keep the queued receipt until a real applied event is available. */
      }
    };
    void replay();
    return () => {
      closed = true;
      unsubscribe?.();
    };
  }, [api, pause?.runId, pause?.status, pauseRequestId]);
  async function perform(job: () => Promise<void>) {
    if (inFlight.current) return;
    const epoch = scope.current;
    inFlight.current = true;
    setPending(true);
    setError("");
    try {
      await job();
    } catch (reason) {
      if (epoch === scope.current)
        setError(
          reason instanceof Error
            ? reason.message
            : "指令未完成，请核对原回执。",
        );
    } finally {
      if (epoch === scope.current) {
        inFlight.current = false;
        setPending(false);
      }
    }
  }
  async function review(text: string, requestId?: string) {
    if (!supported || !sessionId) {
      setError("当前预览未提供宿主指令，请打开桌面 App 或每日计划。");
      return;
    }
    const epoch = scope.current;
    await perform(async () => {
      const view = await api.reviewChatCommand({
        sessionId,
        text,
        ...(requestId ? { requestId } : {}),
      });
      if (epoch === scope.current) {
        setReviews((previous) => merge(previous, [view]));
        setPicker(undefined);
      }
    });
  }
  async function reviewIntent(
    target: NonNullable<ChatHostAction["intentTarget"]>,
  ) {
    if (
      !supported ||
      !sessionId ||
      typeof api.reviewChatIntent !== "function"
    ) {
      setError("当前版本未提供对话日常检查，请使用运行保存的日常。");
      return;
    }
    const epoch = scope.current;
    await perform(async () => {
      const view = await api.reviewChatIntent({ sessionId, ...target });
      if (epoch === scope.current) {
        setReviews((previous) => merge(previous, [view]));
        setPicker(undefined);
      }
    });
  }
  useEffect(() => {
    if (
      !action ||
      action.sessionId !== sessionId ||
      action.key <= handled.current
    )
      return;
    handled.current = action.key;
    setError("");
    setPause(undefined);
    setSelectedId("");
    if (action.intentTarget) void reviewIntent(action.intentTarget);
    else if (action.kind === "saved-daily") void review(action.text);
    else setPicker(action.kind);
  }, [action?.key, sessionId]);
  const choices = requests
    .filter((request) =>
      picker === "pause"
        ? request.status === "running"
        : ["failed", "unknown", "cancelled"].includes(request.status) &&
          !request.resolution,
    )
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  const displayed = reviews.filter((view) => view.sessionId === sessionId);
  if (
    !displayed.length &&
    !picker &&
    !pending &&
    !error &&
    !readError &&
    !pause
  )
    return null;
  return (
    <section className="chat-host-commands" aria-label="聊天宿主指令">
      {pending && (
        <p className="chat-command-pending" role="status">
          <Clock3 size={14} />
          正在核对宿主计划与回执…
        </p>
      )}
      {(error || readError) && (
        <p className="banner warning" role="alert">
          <CircleX size={14} /> {error || readError}
        </p>
      )}
      {picker && (
        <ChatCommandRequestPicker
          kind={picker}
          requests={choices}
          selectedId={selectedId}
          pending={pending}
          onSelect={setSelectedId}
          onReview={() => {
            if (!selectedId || !api || !sessionId) return;
            if (picker === "continue") void review("继续原失败", selectedId);
            else if (typeof api.pauseAfterStep === "function") {
              const epoch = scope.current;
              void perform(async () => {
                const receipt = await api.pauseAfterStep({
                  sessionId,
                  requestId: selectedId,
                  revision: 1,
                });
                if (epoch === scope.current) {
                  setPauseRequestId(selectedId);
                  setPause(receipt);
                  setPicker(undefined);
                }
              });
            } else setError("当前预览未提供步骤边界暂停，请使用停止任务。");
          }}
        />
      )}
      {pause && <ChatPauseReceipt receipt={pause} />}
      {displayed.map((view) => (
        <ChatCommandReviewCard
          key={view.reviewId}
          view={view}
          sessionId={sessionId}
          pending={pending}
          api={api}
          active={requests.some(
            (request) =>
              request.status === "running" &&
              view.receipt?.requestIds.includes(request.id),
          )}
          originPrompt={
            turns.find(
              (turn) =>
                turn.id === view.origin?.turnId &&
                turn.planner.requestId === view.origin.plannerRequestId,
            )?.prompt
          }
          onOpenExecution={onOpenExecution}
          onConfirm={(value, acknowledgePartial) => {
            if (!api || !sessionId) return;
            const epoch = scope.current;
            void perform(async () => {
              const reply = await confirmReviewedCommand(
                api,
                sessionId,
                value,
                acknowledgePartial,
              );
              if (epoch === scope.current)
                setReviews((previous) => merge(previous, [reply]));
            });
          }}
        />
      ))}
    </section>
  );
}
