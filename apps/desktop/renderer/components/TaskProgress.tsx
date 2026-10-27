import type {
  TaskRecord,
  StepStatus,
} from "../../../../packages/protocol/task-record";
import { games } from "../../../../games/registry";
import RecognitionResult from "./RecognitionResult";

const labels: Record<StepStatus, string> = {
  pending: "等待执行",
  running: "执行中",
  succeeded: "已完成",
  skipped: "已跳过",
  failed: "失败",
  cancelled: "已停止",
  unknown: "结果未知",
  "not-run": "未执行",
};
export default function TaskProgress({
  records = [],
  laneId,
  batchId,
  gameId,
}: {
  records?: TaskRecord[];
  laneId: string;
  batchId?: string;
  gameId: string;
}) {
  const candidates = batchId
    ? records.filter(
        (r) =>
          r.laneId === laneId && r.batchId === batchId && r.gameId === gameId,
      )
    : [];
  if (candidates.length > 1)
    return (
      <p className="helper" role="status" data-task-record-ambiguous="true">
        记录关联待核对：本轮存在多份候选记录，不能据其中一份判断当前请求完成。
      </p>
    );
  const record = candidates[0];
  if (!record)
    return (
      <p className="helper">
        暂无本轮分步记录；未开始的游戏和旧版记录不推断完成。
      </p>
    );
  return <TaskRecordProgress record={record} />;
}

export function TaskRecordProgress({ record }: { record: TaskRecord }) {
  const done = record.steps.filter((s) =>
    ["succeeded", "skipped"].includes(s.status),
  ).length;
  const game = games.find((g) => g.id === record.gameId);
  return (
    <div className="task-progress">
      <div className="task-progress-heading">
        <span>
          {record.plan.mode === "rehearsal"
            ? "演练记录 · 未操作游戏"
            : "执行记录"}
        </span>
        <span>
          {done}/{record.steps.length} 项结束
        </span>
      </div>
      <p className="helper">
        {new Date(record.startedAt).toLocaleString("zh-CN")} · {record.message}
      </p>
      <ul className="task-steps">
        {record.steps.map((step) => (
          <li key={step.skillId} data-state={step.status}>
            <details
              open={["failed", "unknown", "running"].includes(step.status)}
            >
              <summary>
                <span>
                  {game?.skills.find((s) => s.id === step.skillId)?.title ??
                    step.skillId}
                </span>
                <span className="task-step-status">
                  {step.status === "succeeded" &&
                  step.evidence === "adapter-return"
                    ? "执行器完成"
                    : step.status === "succeeded" &&
                        record.plan.mode === "rehearsal"
                      ? "演练完成"
                      : labels[step.status]}
                </span>
              </summary>
              <p>{step.message}</p>
              {(step.evidence === "adapter-return" ||
                step.result?.arknights?.completion === "native-confirmed") && (
                <p className="helper">
                  表示该任务流程返回成功，不代表每项奖励都实际产生。
                </p>
              )}
              {step.result?.arknights && (
                <p className="helper">
                  {step.result.arknights.submission === "not-submitted"
                    ? "提交前已停止，未调用此项游戏任务。"
                    : step.result.arknights.completion === "native-confirmed"
                      ? "收到对应任务编号的原生完成回调。"
                      : "已提交游戏任务，完成状态未知，不能直接重做。"}
                  {step.result.arknights.login &&
                    (step.result.arknights.login.method === "profile"
                      ? " 已核对个人名片双帧 UID，并确认返回主页。"
                      : " 登录后已核对双帧主页与绑定 UID。")}
                </p>
              )}
              {step.result?.arknights?.copilot && (
                <div className="copilot-result-proof">
                  <p>
                    目标关卡：{step.result.arknights.copilot.stageId} ·
                    已核验三星结算{" "}
                    {step.result.arknights.copilot.settlements.length}/
                    {step.result.arknights.copilot.plannedRuns}场
                  </p>
                  {step.result.arknights.copilot.verification?.after &&
                  step.result.arknights.completion === "native-confirmed" ? (
                    <p className="helper">
                      执行前后已核对个人名片UID，返回主页时间：
                      {new Date(
                        step.result.arknights.copilot.verification.after
                          .homeObservedAt,
                      ).toLocaleString("zh-CN")}
                      。身份与结算证明保存在本次请求中。
                    </p>
                  ) : (
                    <p className="helper">
                      本次账号、逐场结算或返回主页证据仍不完整，不能确认作业完成。
                    </p>
                  )}
                </div>
              )}
              {step.finishedAt && (
                <time className="helper">
                  {new Date(step.finishedAt).toLocaleString("zh-CN")}
                </time>
              )}
              {step.result?.arknights?.recognition && (
                <RecognitionResult output={step.result.arknights.recognition} />
              )}
              {!!step.diagnostics.length && (
                <details className="task-diagnostics">
                  <summary>查看最近诊断</summary>
                  <pre>{step.diagnostics.join("\n")}</pre>
                </details>
              )}
            </details>
          </li>
        ))}
      </ul>
    </div>
  );
}
