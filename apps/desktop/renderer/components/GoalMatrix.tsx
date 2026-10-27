import type { GoalRun } from "../../../../packages/protocol/agent-goal";
import { goalMatrix, type MatrixTone } from "../goal-matrix-state";
import "../task-panel.css";

const titles: Record<string, string> = {
  arknights: "明日方舟",
  onmyoji: "阴阳师",
};
const states: Record<MatrixTone, string> = {
  verified: "已核验完成",
  failed: "步骤失败",
  unknown: "? 未确认",
  waiting: "等待结果",
  excluded: "未交办",
};
export default function GoalMatrix({ goal }: { goal: GoalRun }) {
  const matrix = goalMatrix(goal);
  if (!matrix.rows.length)
    return <p className="helper">原执行范围尚未记录，步骤结果未确认。</p>;
  return (
    <div
      className="goal-matrix-scroll"
      tabIndex={0}
      aria-label="账号与游戏步骤矩阵"
    >
      <table className="goal-matrix">
        <caption>原执行范围 · 宿主步骤核验</caption>
        <thead>
          <tr>
            <th scope="col">账号</th>
            {matrix.gameIds.map((id) => (
              <th scope="col" key={id}>
                {titles[id] ?? id}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {matrix.rows.map((row) => (
            <tr key={row.laneId}>
              <th scope="row">{row.laneId}</th>
              {row.cells.map((cell) => (
                <td
                  key={cell.gameId}
                  data-matrix-tone={cell.tone}
                  data-lane-id={cell.laneId}
                  data-game-id={cell.gameId}
                  data-request-ids={cell.requestIds.join(" ")}
                >
                  <span className="goal-matrix-state">{states[cell.tone]}</span>
                  {cell.total > 0 && (
                    <>
                      <span className="goal-step-count">
                        已核验 {cell.verified} / {cell.total} 步
                      </span>
                      <progress
                        value={cell.verified}
                        max={cell.total}
                        aria-label={`${row.laneId} · ${titles[cell.gameId] ?? cell.gameId} · 已核验步骤`}
                      />
                    </>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
