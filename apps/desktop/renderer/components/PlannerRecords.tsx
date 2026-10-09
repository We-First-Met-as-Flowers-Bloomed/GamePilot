import type { AgentRunSummary } from "../../../../packages/protocol/agent";
import { games } from "../../../../games/registry";
import { plannerLocalTime } from "../planner-form";
import ResultSummary from "./ResultSummary";
import { ExecutionProgressContent } from "./ExecutionProgressPanel";

const labels: Record<string, string> = {
  "recorded-plan-complete": "原请求账本完成",
  unknown: "结果无法确认",
  failed: "记录失败",
  cancelled: "已取消",
  succeeded: "记录成功",
  skipped: "记录跳过",
  running: "记录为运行中",
  pending: "等待执行",
  "not-run": "本轮未执行",
  queued: "排队记录",
  stopping: "停止中记录",
};
export function PlannerRecords({ records }: { records?: AgentRunSummary[] }) {
  if (!records?.length) return null;
  return (
    <section className="agent-records" aria-label="查询证据">
      <h3>查询证据 · 只读账本</h3>
      <p className="helper">
        以下内容来自宿主读取的记录。原请求完成不代表当天全部日常完成；未核验当前游戏、账号身份或奖励到账。
      </p>
      {records.map((record) => (
        <article className="agent-draft-lane" key={record.requestId}>
          <h4>
            {record.laneId} · {record.requestId} ·{" "}
            {labels[record.recordedConclusion] ?? "结果无法确认"}
          </h4>
          <p className="helper">
            {
              {
                daily: "每日请求",
                maintenance: "维护请求",
                single: "单项请求",
              }[record.requestSource]
            }{" "}
            ·{" "}
            {record.startedAt
              ? plannerLocalTime(record.startedAt).replace("T", " ") +
                "（北京时间）"
              : "时间未知"}{" "}
            · {record.complete ? "记录关联完整" : "证据关联不完整"}
            {" · 请求状态："}
            {labels[record.recordedStatus] ?? "结果无法确认"}
          </p>
          {record.resolution && (
            <p className="helper">
              已结束处理，不再续跑 ·{" "}
              {plannerLocalTime(record.resolution.at).replace("T", " ")}
              （北京时间）；原始结果保持不变。
            </p>
          )}
          {record.recordedProgress && (
            <details>
              <summary>原计划与续跑进度 · 记录时间的结果</summary>
              <section className="execution-progress-panel">
                <ExecutionProgressContent progress={record.recordedProgress} />
              </section>
            </details>
          )}
          {record.tasks.map((task) => {
            const game = games.find((g) => g.id === task.gameId);
            return (
              <div key={task.runId}>
                <h4>
                  {game?.name ?? task.gameId} · 游戏日 {task.gameDay ?? "未知"}{" "}
                  {task.finishedGameDay && task.finishedGameDay !== task.gameDay
                    ? `· 结束游戏日 ${task.finishedGameDay} `
                    : ""}
                  · {task.mode === "live" ? "实跑记录" : "演练记录"}
                </h4>
                {task.recordedLogin && (
                  <p className="helper">
                    历史登录核验：
                    {plannerLocalTime(task.recordedLogin.observedAt).replace(
                      "T",
                      " ",
                    )}
                    （北京时间）主页 UID
                    匹配；当前身份未探测，不代表日常或奖励完成。
                  </p>
                )}
                <ul>
                  {task.steps.map((s) => (
                    <li key={s.skillId}>
                      {game?.skills.find((skill) => skill.id === s.skillId)
                        ?.title ?? s.skillId}
                      ：{labels[s.status] ?? "结果无法确认"}
                    </li>
                  ))}
                </ul>
                <ResultSummary summary={task.resultSummary} />
              </div>
            );
          })}
          {record.warnings.map((message, i) => (
            <p className="banner warning" key={i}>
              {message}
            </p>
          ))}
        </article>
      ))}
    </section>
  );
}
