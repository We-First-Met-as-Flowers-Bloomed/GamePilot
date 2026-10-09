import { useState } from "react";
import type { ExecutionRecord } from "../../../../packages/protocol/execution";

const statusLabels: Record<ExecutionRecord["status"], string> = {
  running: "执行中",
  succeeded: "流程结束",
  failed: "失败",
  cancelled: "已停止",
  unknown: "结果未知",
};

/** A bounded list of recent receipts. Exact details are queried separately. */
export default function ExecutionHistory({
  records = [],
  onOpen,
}: {
  records?: ExecutionRecord[];
  onOpen: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const ordered = [...records].sort((a, b) =>
    b.startedAt.localeCompare(a.startedAt),
  );
  const visible = expanded ? ordered : ordered.slice(0, 6);
  return (
    <section className="surface execution-history" aria-label="最近任务">
      <div className="section-label">
        <h2>最近任务</h2>
        {ordered.length > 6 && (
          <button
            className="text-button"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "收起记录" : `查看已载入的 ${ordered.length} 条记录`}
          </button>
        )}
      </div>
      <p className="helper">
        按每次请求分别查看结果。这里只列出最近载入的记录，详情读取对应的完整步骤账本。
      </p>
      {visible.length ? (
        <ul className="execution-history-list">
          {visible.map((record) => {
            const lane = record.snapshot.lane as
              { name?: string; instance?: number } | undefined;
            const agent = record.snapshot.agent as
              { requestId?: string } | undefined;
            const source = agent?.requestId
              ? "AI 任务"
              : record.source === "daily"
                ? "每日计划"
                : record.source === "maintenance"
                  ? "寄养维护"
                  : "单项任务";
            return (
              <li key={record.id}>
                <div>
                  <strong>
                    {typeof lane?.name === "string"
                      ? lane.name
                      : (record.laneId ?? "单设备")}
                  </strong>
                  <p className="helper">
                    {source} ·{" "}
                    {new Date(record.startedAt).toLocaleString("zh-CN", {
                      hour12: false,
                    })}
                  </p>
                  {record.resolution && (
                    <span className="helper">已结束处理 · 原始结果保留</span>
                  )}
                </div>
                <span
                  className={`badge ${["failed", "unknown"].includes(record.status) ? "red" : ""}`}
                >
                  {statusLabels[record.status]}
                </span>
                <button
                  className="button"
                  aria-label={`查看任务详情：${lane?.name ?? record.laneId ?? "单设备"} ${record.startedAt}`}
                  onClick={() => onOpen(record.id)}
                >
                  查看详情
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="empty-log">暂无已载入的任务记录。</p>
      )}
    </section>
  );
}
