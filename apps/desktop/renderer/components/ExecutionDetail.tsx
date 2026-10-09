import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { games } from "../../../../games/registry";
import type { DesktopAPI } from "../../../../packages/protocol";
import type { ExecutionDetail } from "../../../../packages/protocol/execution-detail";
import type { ExecutionStatus } from "../../../../packages/protocol/execution";
import { TaskRecordProgress } from "./TaskProgress";
import ResultSummary from "./ResultSummary";
import ContinuationPanel from "./ContinuationPanel";
import ExecutionProgressPanel from "./ExecutionProgressPanel";
import IncidentAgentPanel from "./IncidentAgentPanel";
import "../execution-detail.css";

const statuses: Record<ExecutionStatus, string> = {
  running: "执行中",
  succeeded: "请求已完成",
  failed: "失败",
  cancelled: "已停止",
  unknown: "结果未知",
};
const sources = {
  single: "单项执行",
  daily: "每日计划",
  maintenance: "寄养维护",
};
const dateLabel = (at: string) =>
  new Date(at).toLocaleString("zh-CN", { hour12: false });

export function ExecutionDetailContent({
  detail,
  progress,
}: {
  detail: ExecutionDetail;
  progress?: ReactNode;
}) {
  const { request } = detail;
  return (
    <>
      <section className="execution-detail-overview" aria-label="请求概况">
        <div className="execution-detail-status-row">
          <span className="execution-detail-status" data-state={request.status}>
            {statuses[request.status]}
          </span>
          <span className="helper">
            {request.agentRequestId ? "AI · " : ""}
            {sources[request.source]}
          </span>
        </div>
        <p className="execution-detail-message">{request.message}</p>
        {request.continuation && (
          <div className="execution-detail-resolution">
            <strong>按进度续跑</strong>
            <p>原请求：{request.continuation.parentId}</p>
            {(
              [
                ["保留原记录", request.continuation.retained],
                ["本次取消，未计为完成", request.continuation.excluded],
              ] as const
            ).map(
              ([label, entries]) =>
                entries.length > 0 && (
                  <p key={label}>
                    {label}：
                    {entries
                      .flatMap((entry) =>
                        entry.skillIds.map(
                          (id) =>
                            games
                              .find((game) => game.id === entry.gameId)
                              ?.skills.find((skill) => skill.id === id)
                              ?.title ?? id,
                        ),
                      )
                      .join("、")}
                  </p>
                ),
            )}
            <p className="helper">本次重新登录核验，只执行下方所选任务。</p>
          </div>
        )}
        <dl className="execution-detail-metadata">
          <div>
            <dt>设备</dt>
            <dd>{request.laneName ?? "未记录"}</dd>
          </div>
          <div>
            <dt>模拟器实例</dt>
            <dd>
              {request.instance === undefined
                ? "未记录"
                : `MuMu ${request.instance}`}
            </dd>
          </div>
          <div>
            <dt>账号档案</dt>
            <dd>{request.profileName ?? "未记录"}</dd>
          </div>
          <div>
            <dt>开始时间</dt>
            <dd>
              <time dateTime={request.startedAt}>
                {dateLabel(request.startedAt)}
              </time>
            </dd>
          </div>
          <div>
            <dt>结束时间</dt>
            <dd>
              {request.finishedAt ? (
                <time dateTime={request.finishedAt}>
                  {dateLabel(request.finishedAt)}
                </time>
              ) : request.status === "running" ? (
                "进行中"
              ) : (
                "未记录"
              )}
            </dd>
          </div>
        </dl>
        <p className="helper execution-detail-scope-note">
          以上范围来自本次请求保存的信息。请求完成仅表示执行流程结束，具体结果以各步骤证据为准。
        </p>
        {request.resolution && (
          <div className="execution-detail-resolution">
            <strong>已结束处理</strong>
            <p>{request.resolution.note}</p>
            <p className="helper">
              <time dateTime={request.resolution.at}>
                {dateLabel(request.resolution.at)}
              </time>{" "}
              · 未将原始结果标记为成功。
            </p>
          </div>
        )}
      </section>
      {detail.warnings.length > 0 && (
        <section className="execution-detail-warnings" aria-label="记录提示">
          <h3>记录提示</h3>
          <ul>
            {detail.warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </section>
      )}
      {progress}
      <section className="execution-detail-games" aria-label="游戏任务">
        <h3>游戏任务</h3>
        {!detail.games.length && (
          <p className="helper">
            此请求没有可展示的游戏计划，不能据此推断任务是否完成。
          </p>
        )}
        {detail.games.map(({ plan, record, summary, issue }, index) => {
          const game = games.find((candidate) => candidate.id === plan.gameId);
          return (
            <section
              className="execution-detail-game"
              key={`${plan.gameId}-${index}`}
            >
              <h4>{game?.name ?? plan.gameId}</h4>
              {issue && <p className="execution-detail-issue">{issue}</p>}
              <ResultSummary summary={summary} />
              {record ? (
                <TaskRecordProgress record={record} />
              ) : (
                <>
                  <p className="helper">
                    {plan.mode === "rehearsal"
                      ? "演练计划 · 未操作游戏"
                      : "已保存的执行计划"}
                  </p>
                  <ul className="execution-detail-planned-skills">
                    {plan.skillIds.map((skillId) => (
                      <li key={skillId}>
                        {game?.skills.find((skill) => skill.id === skillId)
                          ?.title ?? skillId}
                      </li>
                    ))}
                  </ul>
                  <p className="helper">
                    缺少可靠的分步记录，不推断是否执行或完成。
                  </p>
                </>
              )}
            </section>
          );
        })}
      </section>
      <details className="execution-detail-technical">
        <summary>技术信息</summary>
        <dl className="execution-detail-metadata">
          <div>
            <dt>执行请求编号</dt>
            <dd>{request.id}</dd>
          </div>
          {request.agentRequestId && (
            <div>
              <dt>AI 请求编号</dt>
              <dd>{request.agentRequestId}</dd>
            </div>
          )}
          {request.laneId && (
            <div>
              <dt>设备槽位编号</dt>
              <dd>{request.laneId}</dd>
            </div>
          )}
          {request.batchId && (
            <div>
              <dt>批次编号</dt>
              <dd>{request.batchId}</dd>
            </div>
          )}
          {detail.games.map(
            ({ record }, index) =>
              record && (
                <div key={index}>
                  <dt>
                    {games.find((game) => game.id === record.gameId)?.name ??
                      record.gameId}
                    运行编号
                  </dt>
                  <dd>{record.runId}</dd>
                </div>
              ),
          )}
        </dl>
      </details>
    </>
  );
}

type DetailState = {
  requestId: string;
  detail?: ExecutionDetail;
  error?: string;
  loading: boolean;
};

export default function ExecutionDetailDialog({
  api,
  requestId,
  onClose,
  onOpenExecution,
}: {
  api?: DesktopAPI;
  requestId: string;
  onClose: () => void;
  onOpenExecution?: (id: string) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const refreshRef = useRef<(() => Promise<void>) | undefined>(undefined);
  const pendingRef = useRef<Promise<ExecutionDetail> | undefined>(undefined);
  const [state, setState] = useState<DetailState>({ requestId, loading: true });
  const [progressRevision, setProgressRevision] = useState(0);
  const visible =
    state.requestId === requestId ? state : { requestId, loading: true };

  useEffect(() => {
    const dialog = dialogRef.current;
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
    const previousOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    dialog?.showModal();
    return () => {
      dialog?.close();
      document.documentElement.style.overflow = previousOverflow;
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let reading = false;
    let latest: ExecutionDetail | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState({ requestId, loading: true });
    if (!api) {
      setState({
        requestId,
        loading: false,
        error: "桌面连接不可用，无法读取任务详情。",
      });
      return;
    }
    const read = async () => {
      if (disposed || reading) return;
      reading = true;
      clearTimeout(timer);
      setState((previous) => ({ ...previous, requestId, loading: true }));
      try {
        // A request change waits for the previous read; no overlapping polling.
        await pendingRef.current?.catch(() => undefined);
        if (disposed) return;
        const pending = api.executionDetail(requestId);
        pendingRef.current = pending;
        let next: ExecutionDetail;
        try {
          next = await pending;
        } finally {
          if (pendingRef.current === pending) pendingRef.current = undefined;
        }
        if (disposed) return;
        if (next.request.id !== requestId)
          throw new Error("返回的请求编号不一致，请重新读取。");
        latest = next;
        setState({ requestId, detail: next, loading: false });
        setProgressRevision((previous) => previous + 1);
      } catch (error) {
        if (!disposed)
          setState({
            requestId,
            detail: latest,
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          });
      } finally {
        reading = false;
        if (!disposed && (!latest || latest.request.status === "running"))
          timer = setTimeout(() => void read(), 2000);
      }
    };
    refreshRef.current = read;
    void read();
    return () => {
      disposed = true;
      clearTimeout(timer);
      if (refreshRef.current === read) refreshRef.current = undefined;
    };
  }, [api, requestId]);

  return (
    <dialog
      className="execution-detail-dialog"
      ref={dialogRef}
      aria-label="任务详情"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="execution-detail-header">
        <div>
          <h2>任务详情</h2>
          <p className="helper">本次请求的计划与执行记录</p>
        </div>
        <div className="execution-detail-actions">
          <button
            type="button"
            className="button"
            disabled={!api || visible.loading}
            onClick={() => void refreshRef.current?.()}
          >
            刷新详情
          </button>
          <button
            type="button"
            className="execution-detail-close"
            aria-label="关闭任务详情"
            onClick={onClose}
            autoFocus
          >
            <X size={18} />
          </button>
        </div>
      </header>
      <div className="execution-detail-body" aria-busy={visible.loading}>
        {visible.error && (
          <div className="execution-detail-error" role="alert">
            <strong>
              {visible.detail
                ? "刷新失败，以下为上次读取的记录，可能不是最新状态。"
                : "读取任务详情失败。"}
            </strong>
            <p>{visible.error}</p>
          </div>
        )}
        {!visible.detail && visible.loading && (
          <p className="helper" role="status">
            正在读取任务详情…
          </p>
        )}
        {visible.detail && (
          <ExecutionDetailContent
            detail={visible.detail}
            progress={
              <ExecutionProgressPanel
                api={api}
                requestId={requestId}
                revision={String(progressRevision)}
                onOpenExecution={onOpenExecution}
              />
            }
          />
        )}
        {visible.detail &&
          ["failed", "unknown"].includes(visible.detail.request.status) &&
          !visible.detail.request.resolution && (
            <IncidentAgentPanel
              key={requestId}
              requestId={requestId}
              api={api}
              disabled={visible.loading || !!visible.error}
              onStarted={onOpenExecution}
            />
          )}
        {visible.detail &&
          ["failed", "cancelled", "unknown"].includes(
            visible.detail.request.status,
          ) &&
          !visible.detail.request.resolution && (
            <ContinuationPanel
              requestId={requestId}
              api={api}
              disabled={visible.loading || !!visible.error}
              onAccepted={() => setProgressRevision((previous) => previous + 1)}
              onStarted={onOpenExecution}
            />
          )}
      </div>
    </dialog>
  );
}
