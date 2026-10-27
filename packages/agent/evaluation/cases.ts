import { gameEvaluationCases } from "../../../games/agent-evaluation";
import type { EvaluationCase } from "./types";
import { incidentEvaluationCases } from "../../../games/agent-incident-evaluation";
export const evaluationCases: EvaluationCase[] = [
  ...gameEvaluationCases,
  ...[
    ["F01", "发现Codex后取消", "取消仅在清理后完成，无存活子进程"],
    ["F02", "未登录", "AUTH_REQUIRED，无模型轮次，无存活子进程"],
    ["F03", "额度不足", "QUOTA_EXCEEDED，不返回草稿"],
    ["F04", "模型进程中途断开", "CODEX_EXITED，确认进程退出"],
    ["F05", "模型持续无输出", "TIMEOUT，有界等待，确认进程退出"],
    ["F06", "取消时清理失败", "SHUTDOWN_FAILED，关闭后续规划入口"],
    ["F07", "并发构建包装器", "每次导入完整独立工件，不覆盖在途构建"],
  ].map(([id, condition, rubric]) => ({
    id,
    mode: "fault-injection" as const,
    prompt: `${gameEvaluationCases[0].prompt}（注入：${condition}）`,
    at: gameEvaluationCases[0].at,
    statuses: [],
    rubric,
  })),
];
export function evaluationSuite(name: unknown = "planning"): EvaluationCase[] {
  if (name === "planning") return evaluationCases;
  if (name === "diagnostics") return incidentEvaluationCases;
  throw Error("评测用例组无效");
}
