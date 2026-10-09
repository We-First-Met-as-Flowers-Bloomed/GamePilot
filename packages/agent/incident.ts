import { createHash } from "node:crypto";
import { canonical } from "../acceptance/files";
import { gameIncidentCodes } from "../../games/agent-incidents";
import type { AgentRunSummary } from "../protocol/agent";
import {
  incidentCodes,
  type AgentIncident,
  type IncidentCode,
  type IncidentSignal,
  type IncidentFault,
} from "../protocol/agent-incident";

export function incidentLogCodes(texts: string[], gameId = ""): IncidentCode[] {
  const codes = new Set<IncidentCode>();
  for (const raw of texts.slice(0, 12)) {
    const text = raw.slice(0, 2000);
    if (
      /MuMu[^\r\n]*启动[^\r\n]*失败|Command failed:[^\r\n]*MuMuManager[^\r\n]*launch/i.test(
        text,
      )
    )
      codes.add("launch-response-failed");
    if (/超时|超过.*时限|timed?\s*out/i.test(text)) codes.add("task-timeout");
    gameIncidentCodes(gameId, text).forEach((c) => codes.add(c));
  }
  return [...codes];
}
const descriptions: Record<IncidentCode, string> = {
  "launch-response-failed":
    "日志匹配到 MuMu 启动响应异常；内部原因和当前启动状态未确认",
  "task-timeout": "日志匹配到超时提示；不能据此断定网络故障或任务未提交",
  "ark-announcement": "日志提及公告处理或月饼教程；不能据此证明当前卡在该页面",
  "foster-list-progress":
    "日志提及寄养好友列表扫描；是否无进展需现场或连续帧验证",
  "foster-return": "日志匹配到寄养返回庭院失败；不代表寄养未放入",
  "native-unconfirmed":
    "结构化记录显示原生任务已提交但完成未确认；禁止凭此重放",
  "foster-recheck-recorded":
    "步骤内曾安排寄养复查时间，可能来自兜底间隔；不证明识别到了倒计时、寄养已放入或整轮完成",
};
export function buildIncident(
  run: AgentRunSummary,
  signals: IncidentSignal[],
  environmentRevision: string,
  capturedAt?: string,
  faults: IncidentFault[] = [],
): AgentIncident {
  const associated = signals.filter(
    (s) =>
      s.requestId === run.requestId &&
      incidentCodes.includes(s.code) &&
      (s.basis === "log-pattern" || s.basis === "structured-record") &&
      (!s.runId
        ? !s.skillId
        : run.tasks.some(
            (t) =>
              t.runId === s.runId &&
              (!s.skillId ||
                t.steps.some((step) => step.skillId === s.skillId)),
          )),
  );
  const body = {
    version: 1 as const,
    source: "recorded" as const,
    environmentRevision,
    capturedAt,
    run: structuredClone(run),
    faults: faults
      .filter(
        (f) =>
          f.requestId === run.requestId &&
          run.tasks.some(
            (t) =>
              t.runId === f.runId &&
              (!f.skillId || t.steps.some((s) => s.skillId === f.skillId)),
          ),
      )
      .slice(0, 32)
      .map((f, i) => ({
        requestId: f.requestId,
        runId: f.runId,
        skillId: f.skillId,
        code: f.code,
        source: f.source,
        observedAt: f.observedAt,
        captureStatus: f.captureStatus,
        imageSent: false as const,
        evidenceId: `fault-${i + 1}`,
      })),
    signals: associated.slice(0, 40).map((s, i) => ({
      requestId: s.requestId,
      runId: s.runId,
      skillId: s.skillId,
      code: s.code,
      basis: s.basis,
      evidenceId: `signal-${i + 1}`,
      description: descriptions[s.code],
    })),
    omittedSignals: Math.max(0, associated.length - 40),
    gaps: [
      "startupFault是程序记录的模拟器启动阶段异常，没有截图，不证明设备现在仍故障或根因已确定",
      "仅为持久账本快照，未探测设备、当前前台游戏或账号身份",
      "faults为程序在异常处记录的类型，仍不证明底层根因；stored只表示当时本地保存，未读取或上传图片，不能断言其画面内容或现在仍存在",
      "未读取截图、OCR全文或外部引擎日志；日志模式命中不是根因证明，未命中不表示无故障",
      "旧记录可能未保存版本、设备启动stderr或足够步骤；缺失证据不能补造",
      ...(!run.complete
        ? ["请求的步骤证据关联不完整，先核对缺失或冲突记录"]
        : []),
      "未读取故障Agent的诊断会话历史、模型调用或恢复事件；这些历史未知，不能据此说未调用其他诊断或模型，也不能说已经恢复",
      "execution=not-started仅表示本次只读查询未执行游戏，不表示独立的故障诊断或模型调用未运行",
      "recoverySkills为空、canExecute=false仅表示本查询未提供恢复执行授权，不代表应用没有其他诊断或受限恢复工具；未知结果不重放，本查询不会解除暂停或改写账本",
    ],
    recoverySkills: [] as [],
    canExecute: false as const,
    execution: "not-started" as const,
  };
  return {
    ...body,
    bundleHash: createHash("sha256").update(canonical(body)).digest("hex"),
  };
}
