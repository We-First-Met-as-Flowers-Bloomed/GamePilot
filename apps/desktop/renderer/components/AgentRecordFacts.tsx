import type { AgentRunSummary } from "../../../../packages/protocol/agent";
import { games } from "../../../../games/registry";
import { plannerLocalTime } from "../planner-form";

/** Short host-owned facts. No prose is parsed to decide an outcome or invent a number. */
export function AgentRecordFacts({ records }: { records?: AgentRunSummary[] }) {
  if (!records?.length) return null;
  const statuses: Record<string, string> = {
    succeeded: "请求记录成功",
    failed: "原请求失败",
    cancelled: "原请求已停止",
    unknown: "结果未知",
    running: "记录为运行中",
  };
  return (
    <section className="agent-record-facts" aria-label="宿主核对结果">
      {records.map((record) => (
        <article
          key={record.requestId}
          data-recorded-status={record.recordedStatus}
        >
          <span className="badge agent-host-badge">宿主核验</span>
          <strong>
            {record.laneId ?? "原账号"} ·{" "}
            {statuses[record.recordedStatus] ?? "结果待核对"}
          </strong>
          {record.startedAt && (
            <p className="helper">
              {plannerLocalTime(record.startedAt).replace("T", " ")}（北京时间）
            </p>
          )}
          {record.recordedProgress && (
            <p>
              {record.recordedProgress.wholePlanComplete
                ? "关联账本已补齐原计划步骤；原请求状态保留。"
                : "尚不能确认原计划全部补齐。"}
            </p>
          )}
          {record.tasks.map((task) => (
            <div key={task.runId}>
              <span>
                {games.find((game) => game.id === task.gameId)?.name ??
                  task.gameId}{" "}
                · 游戏日 {task.gameDay ?? "未知"}
                {task.mode === "rehearsal" ? " · 演练" : ""}
              </span>
              {!!task.resultSummary?.items.length && (
                <ul>
                  {task.resultSummary.items.map((item) => (
                    <li key={item.id}>
                      {item.label}：{item.value}
                      {item.note ? `（${item.note}）` : ""}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </article>
      ))}
      <p className="helper">
        来自记录时间的宿主账本；当前现场及当天整套日常需另行核验。
      </p>
    </section>
  );
}
