import { useEffect, useRef, useState } from "react";
import type { DesktopAPI } from "../../../../packages/protocol";
import type { ExecutionDetail } from "../../../../packages/protocol/execution-detail";
import type { TaskResultSummary } from "../../../../packages/protocol/task-result-summary";
import { games } from "../../../../games/registry";
import "../result-summary.css";

const counts = {
  completed: "完成",
  skipped: "已跳过",
  failed: "失败",
  unknown: "结果未知",
  notRun: "未执行",
  running: "执行中",
  pending: "等待",
  cancelled: "已停止",
} as const;

/** Presentation only: values have already been scoped and checked by the host. */
export default function ResultSummary({
  summary,
}: {
  summary?: TaskResultSummary;
}) {
  if (!summary)
    return (
      <p className="helper result-summary-missing">
        未记录结果汇总，不能据此推断完成情况或实际数量。
      </p>
    );
  return (
    <section className="result-summary" aria-label="任务结果汇总">
      {summary.mode === "rehearsal" && (
        <p className="result-summary-rehearsal">演练记录 · 未操作游戏</p>
      )}
      <ul className="result-summary-counts" aria-label="步骤状态">
        {Object.entries(counts).map(([key, label]) => {
          const value = summary.counts[key as keyof typeof counts];
          return value > 0 ? (
            <li key={key} data-state={key}>
              <span>{label}</span>
              <strong>{value}</strong>
            </li>
          ) : null;
        })}
      </ul>
      {summary.items.length > 0 ? (
        <dl className="result-summary-values">
          {summary.items.map((item) => (
            <div key={item.id} data-state={item.status}>
              <dt>{item.label}</dt>
              <dd>{item.value}</dd>
              {item.note && (
                <dd className="helper result-summary-note">{item.note}</dd>
              )}
            </div>
          ))}
        </dl>
      ) : (
        <p className="helper">本次没有已记录的数量指标。</p>
      )}
      {summary.issues.length > 0 && (
        <div className="result-summary-issues">
          <strong>需要留意</strong>
          <ul>
            {summary.issues.map((issue, index) => (
              <li key={`${issue.skillId}-${index}`}>{issue.message}</li>
            ))}
          </ul>
        </div>
      )}
      <p className="helper result-summary-scope">{summary.scopeNote}</p>
    </section>
  );
}

type ReadState = {
  requestId?: string;
  detail?: ExecutionDetail;
  loading: boolean;
  error?: string;
};

/** Reads one original daily receipt; later single tasks cannot replace its outcome. */
export function DailyResultSummary({
  api,
  requestId,
  laneId,
}: {
  api?: DesktopAPI;
  requestId?: string;
  laneId: string;
}) {
  const [state, setState] = useState<ReadState>({
    requestId,
    loading: Boolean(requestId),
  });
  const refreshRef = useRef<(() => Promise<void>) | undefined>(undefined);
  const visible =
    state.requestId === requestId
      ? state
      : { requestId, loading: Boolean(requestId) };
  useEffect(() => {
    let disposed = false;
    let reading = false;
    let latest: ExecutionDetail | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState({ requestId, loading: Boolean(requestId) });
    if (!requestId) return;
    if (!api) {
      setState({
        requestId,
        loading: false,
        error: "桌面连接不可用，无法读取结果。",
      });
      return;
    }
    const read = async () => {
      if (disposed || reading) return;
      reading = true;
      clearTimeout(timer);
      setState((previous) => ({ ...previous, requestId, loading: true }));
      try {
        const detail = await api.executionDetail(requestId);
        if (disposed) return;
        if (
          detail.request.id !== requestId ||
          detail.request.laneId !== laneId ||
          detail.request.source !== "daily"
        )
          throw Error("记录与本次日常账号不一致，无法展示结果。");
        latest = detail;
        setState({ requestId, detail, loading: false });
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
  }, [api, requestId, laneId]);
  return (
    <section
      className="daily-result-summary"
      aria-label="本次日常结果"
      aria-busy={visible.loading}
    >
      <div className="section-label">
        <h4>本次日常结果</h4>
        {requestId && (
          <button
            type="button"
            className="text-button"
            disabled={!api || visible.loading}
            onClick={() => void refreshRef.current?.()}
          >
            刷新结果
          </button>
        )}
      </div>
      {!requestId && (
        <p className="helper">
          暂无可关联的日常记录；单项任务在最近任务中单独查看。
        </p>
      )}
      {visible.error && (
        <div className="result-summary-error" role="alert">
          <strong>
            {visible.detail
              ? "刷新失败，以下为上次读取的结果。"
              : "读取结果失败。"}
          </strong>
          <p>{visible.error}</p>
        </div>
      )}
      {!visible.detail && visible.loading && (
        <p className="helper" role="status">
          正在读取结果…
        </p>
      )}
      {visible.detail && (
        <>
          <p className="helper result-summary-time">
            <time dateTime={visible.detail.request.startedAt}>
              {new Date(visible.detail.request.startedAt).toLocaleString(
                "zh-CN",
                { hour12: false },
              )}
            </time>{" "}
            · 原日常请求
          </p>
          {!visible.detail.games.length && <ResultSummary />}
          {visible.detail.games.map(({ plan, summary, issue }, index) => (
            <section
              className="daily-result-game"
              key={`${plan.gameId}-${index}`}
            >
              <h5>
                {games.find((game) => game.id === plan.gameId)?.name ??
                  plan.gameId}
              </h5>
              {issue && <p className="result-summary-error">{issue}</p>}
              <ResultSummary summary={summary} />
            </section>
          ))}
          {visible.detail.warnings.length > 0 && (
            <ul className="result-summary-warnings">
              {visible.detail.warnings.map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
          )}
          <p className="helper result-summary-boundary">
            仅此日常请求。后续单项结果单独保留，不会将原失败改为成功。
          </p>
        </>
      )}
    </section>
  );
}
