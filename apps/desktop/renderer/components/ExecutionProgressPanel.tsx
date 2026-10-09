import { useEffect, useRef, useState } from "react";
import type { DesktopAPI } from "../../../../packages/protocol";
import type { ExecutionProgress } from "../../../../packages/protocol/execution-progress";
import type { ExecutionStatus } from "../../../../packages/protocol/execution";
import { games } from "../../../../games/registry";
import "./execution-progress.css";

const requestLabels: Record<ExecutionStatus, string> = {
  running: "执行中",
  succeeded: "请求已完成",
  failed: "失败",
  cancelled: "已停止",
  unknown: "结果未知",
};
const stepLabels: Record<ExecutionProgress["steps"][number]["status"], string> =
  {
    pending: "等待执行",
    running: "执行中",
    succeeded: "已完成",
    skipped: "已跳过",
    failed: "失败",
    cancelled: "已停止",
    unknown: "结果未知",
    "not-run": "未执行",
    excluded: "已取消，未计为完成",
  };
const outcomeLabels: Record<ExecutionProgress["outcome"], string> = {
  complete: "本轮原计划已完成",
  recovered: "原计划已补齐",
  partial: "已结束，含取消任务",
  running: "原计划执行中",
  incomplete: "原计划尚未完成",
  unconfirmed: "原计划结果待核对",
};

/** Only displays the host's verified original-plan coverage. */
export function ExecutionProgressContent({
  progress,
  onOpenExecution,
}: {
  progress: ExecutionProgress;
  onOpenExecution?: (id: string) => void;
}) {
  return (
    <div className="execution-progress-content">
      <div className="execution-progress-heading">
        <h4>原计划进度</h4>
        <span
          className="execution-progress-outcome"
          data-outcome={progress.outcome}
        >
          {outcomeLabels[progress.outcome]}
        </span>
      </div>
      <p className="execution-progress-scope">
        {progress.source === "daily"
          ? "本轮每日计划"
          : progress.source === "single"
            ? "本次单项计划 · 不代表整套日常完成"
            : "本次寄养维护计划 · 不代表整套日常完成"}
        {" · 原请求："}
        {requestLabels[progress.originalStatus]}
      </p>
      <ul className="execution-progress-counts" aria-label="原计划业务任务统计">
        <li>
          完成{" "}
          <strong>
            {progress.counts.completed}/{progress.counts.total}
          </strong>
        </li>
        <li>
          已跳过 <strong>{progress.counts.skipped}</strong>
        </li>
        <li>
          已取消 <strong>{progress.counts.excluded}</strong>
        </li>
        <li>
          待完成 <strong>{progress.counts.remaining}</strong>
        </li>
      </ul>
      <p className="helper execution-progress-note">
        登录核验为必需前置，不计入业务任务数量。已跳过与已取消分别列出；取消任务未计为完成。
      </p>
      {progress.steps.length > 0 ? (
        <ul className="execution-progress-steps">
          {progress.steps.map((step) => {
            const game = games.find(
              (candidate) => candidate.id === step.gameId,
            );
            return (
              <li
                key={`${step.gameId}-${step.skillId}`}
                data-progress-state={step.status}
              >
                <details>
                  <summary>
                    <span>
                      {game?.skills.find((skill) => skill.id === step.skillId)
                        ?.title ?? step.skillId}
                    </span>
                    <span className="execution-progress-step-status">
                      {stepLabels[step.status]}
                      {step.skillId === "login" ? " · 必需前置" : ""}
                      {step.continued ? " · 续跑" : ""}
                    </span>
                  </summary>
                  <p>
                    {game?.name ?? step.gameId} ·{" "}
                    {step.continued ? "续跑记录" : "原请求记录"}
                  </p>
                  <p>
                    记录来源：<code>{step.sourceId}</code>
                  </p>
                  {onOpenExecution && (
                    <button
                      type="button"
                      className="button"
                      onClick={() => onOpenExecution(step.sourceId)}
                    >
                      查看来源详情
                    </button>
                  )}
                </details>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="helper">没有可确认的原计划步骤，不能据此推断完成。</p>
      )}
      {progress.warnings.length > 0 && (
        <ul className="execution-progress-warnings" aria-label="原计划进度提示">
          {progress.warnings.map((warning, index) => (
            <li key={index}>{warning}</li>
          ))}
        </ul>
      )}
      <details className="execution-progress-requests">
        <summary>原请求与续跑记录（{progress.requests.length}）</summary>
        <ul>
          {progress.requests.map((request) => (
            <li key={request.id}>
              <span>
                {request.id === progress.rootId ? "原请求" : "续跑"} ·{" "}
                {requestLabels[request.status]}
              </span>
              <code>{request.id}</code>
              {onOpenExecution && (
                <button
                  type="button"
                  className="button"
                  onClick={() => onOpenExecution(request.id)}
                >
                  查看详情
                </button>
              )}
            </li>
          ))}
        </ul>
      </details>
      {onOpenExecution && progress.latestId !== progress.rootId && (
        <div className="execution-progress-actions">
          <button
            type="button"
            className="button"
            onClick={() => onOpenExecution(progress.rootId)}
          >
            查看原请求
          </button>
          <button
            type="button"
            className="button"
            onClick={() => onOpenExecution(progress.latestId)}
          >
            查看最近续跑
          </button>
        </div>
      )}
    </div>
  );
}

type ReadState = {
  requestId?: string;
  laneId?: string;
  progress?: ExecutionProgress;
  loading: boolean;
  error?: string;
};

export default function ExecutionProgressPanel({
  api,
  requestId,
  laneId,
  revision,
  onOpenExecution,
}: {
  api?: DesktopAPI;
  requestId?: string;
  laneId?: string;
  revision?: string;
  onOpenExecution?: (id: string) => void;
}) {
  const [state, setState] = useState<ReadState>({
    requestId,
    laneId,
    loading: !!requestId,
  });
  const latestRef = useRef<ReadState>(state);
  const pendingRef = useRef<Promise<ExecutionProgress> | undefined>(undefined);
  const refreshRef = useRef<(() => Promise<void>) | undefined>(undefined);
  const visible =
    state.requestId === requestId && state.laneId === laneId
      ? state
      : { requestId, laneId, loading: !!requestId };

  useEffect(() => {
    let disposed = false;
    let reading = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let latest =
      latestRef.current.requestId === requestId &&
      latestRef.current.laneId === laneId
        ? latestRef.current.progress
        : undefined;
    const update = (next: ReadState) => {
      latestRef.current = next;
      setState(next);
    };
    if (!requestId || !api) {
      update({
        requestId,
        laneId,
        loading: false,
        error: requestId ? "桌面连接不可用，无法读取原计划进度。" : undefined,
      });
      return;
    }
    const read = async () => {
      if (disposed || reading) return;
      reading = true;
      clearTimeout(timer);
      update({ requestId, laneId, progress: latest, loading: true });
      try {
        // Wait out an old scope/revision read before starting the next one.
        await pendingRef.current?.catch(() => undefined);
        if (disposed) return;
        const pending = api.executionProgress(requestId);
        pendingRef.current = pending;
        let next: ExecutionProgress;
        try {
          next = await pending;
        } finally {
          if (pendingRef.current === pending) pendingRef.current = undefined;
        }
        if (disposed) return;
        if (next.requestId !== requestId || (laneId && next.laneId !== laneId))
          throw new Error("返回的原计划范围不一致，请重新读取。");
        latest = next;
        update({ requestId, laneId, progress: next, loading: false });
      } catch (error) {
        if (!disposed)
          update({
            requestId,
            laneId,
            progress: latest,
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          });
      } finally {
        reading = false;
        // A terminal original request may still have an active continuation.
        if (
          !disposed &&
          (!latest ||
            latest.outcome === "running" ||
            latest.requests.some((request) => request.status === "running"))
        )
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
  }, [api, requestId, laneId, revision]);

  return (
    <section
      className="execution-progress-panel"
      aria-label="原计划与续跑进度"
      aria-busy={visible.loading}
    >
      {visible.progress ? (
        <ExecutionProgressContent
          progress={visible.progress}
          onOpenExecution={onOpenExecution}
        />
      ) : (
        <>
          <h4>原计划进度</h4>
          <p className="helper" role="status">
            {requestId
              ? visible.loading
                ? "正在读取原计划与续跑进度…"
                : "未读取到原计划进度，不能推断完成。"
              : "暂无可确认的原计划记录，不能推断完成。"}
          </p>
        </>
      )}
      {visible.error && (
        <p className="execution-progress-error" role="alert">
          {visible.progress
            ? "刷新失败，显示的是上次读取的进度，可能不是最新状态。 "
            : ""}
          {visible.error}
        </p>
      )}
      {requestId && (
        <button
          type="button"
          className="button execution-progress-refresh"
          disabled={!api || visible.loading}
          onClick={() => void refreshRef.current?.()}
        >
          刷新原计划进度
        </button>
      )}
    </section>
  );
}
