import type { ExecutionRecord } from "../../../../packages/protocol/execution";
import type { DesktopAPI } from "../../../../packages/protocol";
import RecoveryPanel from "./RecoveryPanel";

export default function ExecutionNotice({
  records = [],
  api,
  disabled = false,
  onResolved,
  onOpenExecution,
}: {
  records?: ExecutionRecord[];
  api?: DesktopAPI;
  disabled?: boolean;
  onResolved?: (record: ExecutionRecord) => void;
  onOpenExecution?: (id: string) => void;
}) {
  const interrupted = records.filter(
    (record) =>
      ["unknown", "failed", "cancelled"].includes(record.status) &&
      (record.snapshot.plan as { mode?: string } | undefined)?.mode !==
        "rehearsal",
  );
  const unknown = interrupted.filter((record) => !record.resolution);
  const resolved = interrupted.filter((record) => record.resolution);
  if (!interrupted.length) return null;
  return (
    <details
      className={`banner ${unknown.length ? "warning" : ""} execution-notice`}
    >
      <summary>
        {unknown.length
          ? `${unknown.length} 次执行结果待核对`
          : `已处理 ${resolved.length} 次中断记录`}
      </summary>
      <p>
        中断记录保留原始结果。处理问题后可继续未完成任务，也可结束此次处理；已完成步骤不重新执行。
      </p>
      <ul>
        {[...unknown, ...resolved].map((record) => (
          <li key={record.id}>
            <strong>
              {String(
                (record.snapshot.lane as { name?: string } | undefined)?.name ??
                  "单项任务",
              )}
            </strong>
            {" · "}
            {new Date(record.startedAt).toLocaleString("zh-CN", {
              hour12: false,
            })}
            {" · "}
            {record.source === "maintenance"
              ? "寄养维护"
              : record.source === "daily"
                ? "每日计划"
                : "单项执行"}
            <p>{record.message}</p>
            {onOpenExecution && (
              <button
                className="button"
                onClick={() => onOpenExecution(record.id)}
              >
                查看任务详情
              </button>
            )}
            <RecoveryPanel
              record={record}
              api={api}
              disabled={disabled}
              onResolved={onResolved}
              onStarted={onOpenExecution}
            />
          </li>
        ))}
      </ul>
    </details>
  );
}
