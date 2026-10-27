import { useEffect, useRef, useState } from "react";
import { Bot, Camera, Check, Clock3, Square } from "lucide-react";
import type { DesktopAPI } from "../../../../packages/protocol";
import type {
  IncidentAgentSession,
  IncidentAgentView,
} from "../../../../packages/protocol/incident-agent";
import {
  incidentResultStatus,
  incidentScreenLabels,
} from "../../../../packages/protocol/incident-agent";
import type { FailureImageView } from "../../../../packages/protocol/failure-view";
import { games } from "../../../../games/registry";
import "./incident-agent.css";
import { useDistinctValue } from "../hooks/useDistinctValue";
import { watchSnapshot } from "../hooks/watchSnapshot";
const stages = {
  queue: "排队",
  evidence: "读取证据",
  model: "模型调用",
  diagnosis: "诊断摘要",
  check: "宿主校验",
  recovery: "受限页面恢复",
  resume: "恢复操作",
  result: "实际结果",
  correction: "用户纠正",
  cancel: "停止",
  error: "异常",
};
const states = {
  queued: "等待设备空闲",
  running: "正在处理",
  "awaiting-user": "等待你核对",
  resumed: "已提交续跑",
  cancelled: "已停止",
  failed: "处理未完成",
};
const resultStates = {
  running: "等待续跑结果",
  succeeded: "原计划已补齐",
  blocked: "续跑待核对",
  failed: "续跑失败",
  unknown: "续跑结果未知",
  cancelled: "续跑已停止",
  partial: "续跑部分完成",
};
export function IncidentTimeline({
  session,
}: {
  session: IncidentAgentSession;
}) {
  return (
    <>
      <ol className="incident-timeline" aria-label="Agent执行时间线">
        {session.events.map((e, i) => {
          const status =
            e.kind === "result" && e.status !== "running"
              ? e.result
                ? incidentResultStatus(e.result)
                : "unknown"
              : e.status;
          return (
            <li key={e.seq} data-status={status}>
              <span className="incident-event-mark" aria-hidden="true">
                {status === "succeeded" ? (
                  <Check size={12} />
                ) : (
                  <Clock3 size={12} />
                )}
              </span>
              <div>
                <div className="incident-event-title">
                  <strong>{stages[e.kind]}</strong>
                  <time dateTime={e.at}>
                    {new Date(e.at).toLocaleTimeString("zh-CN")}
                  </time>
                </div>
                <p>{e.text}</p>
                {e.kind === "result" && status !== "running" && (
                  <p className="helper">
                    {e.result
                      ? e.result.wholePlanComplete
                        ? `已读取续跑结果（${resultStates[status]}）；关联账本确认原计划已补齐，原失败保留。`
                        : `已读取续跑结果（${resultStates[status]}）；原计划尚未补齐，仍需核对。`
                      : "原计划完成情况待账本核对。"}
                  </p>
                )}
                {i === session.events.length - 1 &&
                  ["running", "queued"].includes(session.status) && (
                    <span className="helper">正在等待下一步结果…</span>
                  )}
              </div>
            </li>
          );
        })}
      </ol>
      {session.diagnosis && (
        <div className="incident-diagnosis">
          <span className="eyebrow">诊断摘要 · 模型建议</span>
          {session.model && <span className="helper"> · {session.model}</span>}
          <p>{session.diagnosis.summary}</p>
          <small>
            引用证据：{session.diagnosis.basis.join("、")} ·{" "}
            {session.diagnosis.action === "manual"
              ? "需要你核对"
              : "建议按原进度继续"}
          </small>
        </div>
      )}
      {session.recovery && (
        <div className="incident-recovery-proposal" aria-label="受限恢复提案">
          <span className="eyebrow">宿主受限恢复提案 · 返回主页</span>
          <p>
            在原设备复查已知页面后，使用受限返回动作确认主页；然后重新登录核对UID，执行原计划剩余任务。页面或身份变化会停止恢复。
          </p>
        </div>
      )}
    </>
  );
}
export default function IncidentAgentPanel({
  requestId,
  api,
  disabled,
  onStarted,
}: {
  requestId: string;
  api?: DesktopAPI;
  disabled?: boolean;
  onStarted?: (id: string) => void;
}) {
  const [view, setView] = useState<IncidentAgentView>();
  const unchanged = useDistinctValue();
  const [error, setError] = useState("");
  const [readError, setReadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [ack, setAck] = useState(false);
  const [images, setImages] = useState<Record<string, FailureImageView>>({});
  const mounted = useRef(true);
  const scope = useRef(0);
  const inFlight = useRef(false);
  const s = view?.sessions.find((s) => s.requestId === requestId),
    active = s?.status === "running" || s?.status === "queued";
  useEffect(() => {
    mounted.current = true;
    const current = ++scope.current;
    setView(undefined);
    setError("");
    setReadError("");
    setImages({});
    setBusy(false);
    inFlight.current = false;
    if (!api?.incidentAgentSnapshot) return;
    const close = watchSnapshot({
      read: () => api.incidentAgentSnapshot(),
      subscribe: (refresh) => api.onIncidentAgentState?.(refresh) ?? (() => {}),
      accept: (v) => {
        if (scope.current === current) {
          setReadError("");
          if (unchanged([requestId, v])) setView(v);
        }
      },
      error: () => {
        if (scope.current === current)
          setReadError("无法读取故障处理进度，请稍后重试。");
      },
    });
    return () => {
      scope.current++;
      mounted.current = false;
      close();
    };
  }, [api, requestId]);
  async function act(fn: (current: () => boolean) => Promise<void>) {
    if (inFlight.current || disabled || !api) return;
    inFlight.current = true;
    const epoch = scope.current;
    setBusy(true);
    setError("");
    try {
      await fn(() => mounted.current && scope.current === epoch);
    } catch (e) {
      if (mounted.current && scope.current === epoch)
        setError(e instanceof Error ? e.message : "处理未完成");
    } finally {
      if (scope.current === epoch) {
        inFlight.current = false;
        if (mounted.current) setBusy(false);
      }
    }
  }
  const unavailable = !api?.diagnoseFailure || disabled || busy;
  return (
    <section className="incident-agent-panel" aria-label="Agent故障处理">
      <header>
        <div>
          <Bot size={18} />
          <h3>Agent 故障处理</h3>
        </div>
        <span className="badge">{s ? states[s.status] : "可诊断本次失败"}</span>
      </header>
      <p className="helper">
        失败截图与原请求绑定。自动诊断只发送脱敏账本和本机OCR识别的页面类型；完整截图留在本机。明确的登录网络故障最多自动恢复两次，其余由你核对。
      </p>
      <div className="incident-actions">
        {active ? (
          <button
            className="button"
            disabled={unavailable}
            onClick={() =>
              void act(async (current) => {
                const v = await api!.cancelFailureDiagnosis(requestId);
                if (current()) setView(v);
              })
            }
          >
            <Square size={14} />
            停止Agent处理
          </button>
        ) : (
          s?.status !== "resumed" && (
            <button
              className="button"
              disabled={unavailable}
              onClick={() =>
                void act(async (current) => {
                  setAck(false);
                  const v = await api!.diagnoseFailure({ requestId });
                  if (current()) setView(v);
                })
              }
            >
              <Bot size={14} />
              {s ? "重新诊断" : "让Agent诊断"}
            </button>
          )
        )}
        {s?.successorId && onStarted && (
          <button className="button" onClick={() => onStarted(s.successorId!)}>
            查看续跑任务
          </button>
        )}
      </div>
      {(error || readError || view?.error || s?.error) && (
        <p role="alert" className="banner warning">
          {error || readError || view?.error || s?.error}
        </p>
      )}
      {s && (
        <div className="incident-workspace">
          <div>
            <IncidentTimeline session={s} />
          </div>
          <aside>
            <h4>对应设备的失败现场</h4>
            {!s.screens?.length && (
              <p className="helper">
                读取后显示截图证据；启动前中断可能没有截图。
              </p>
            )}
            {s.screens?.map((screen) => (
              <div className="incident-screen" key={screen.id}>
                <strong>
                  {games.find((g) => g.id === screen.gameId)?.name ??
                    screen.gameId}{" "}
                  · {screen.id}
                </strong>
                <p className="helper">
                  {new Date(screen.observedAt).toLocaleString("zh-CN")} ·{" "}
                  {incidentScreenLabels[screen.page]}
                </p>
                <button
                  className="button"
                  disabled={unavailable}
                  onClick={() =>
                    void act(async (current) => {
                      const image = await api!.readFailureImage({
                        requestId,
                        runId: screen.runId,
                      });
                      if (current())
                        setImages((v) => ({ ...v, [screen.runId]: image }));
                    })
                  }
                >
                  <Camera size={14} />
                  查看本地截图
                </button>
                {images[screen.runId]?.status === "available" && (
                  <img
                    src={(images[screen.runId] as { image: string }).image}
                    alt="本次失败保存的设备历史画面"
                  />
                )}
              </div>
            ))}
            {s.remaining?.length ? (
              <div className="incident-remaining">
                <h4>续跑将执行</h4>
                <ul>
                  {s.remaining.flatMap((g) =>
                    g.skillIds.map((id) => (
                      <li key={`${g.gameId}-${id}`}>
                        {games
                          .find((game) => game.id === g.gameId)
                          ?.skills.find((skill) => skill.id === id)?.title ??
                          id}
                      </li>
                    )),
                  )}
                </ul>
                <p className="helper">
                  重新登录与UID核验为前置，已完成任务保留。
                </p>
              </div>
            ) : null}
            {s.status !== "resumed" && (
              <>
                <label
                  className="incident-feedback"
                  htmlFor={`incident-feedback-${requestId}`}
                >
                  纠正诊断或补充现场
                  <textarea
                    id={`incident-feedback-${requestId}`}
                    rows={3}
                    maxLength={2000}
                    value={feedback}
                    onChange={(e) => setFeedback(e.target.value)}
                    disabled={unavailable}
                    placeholder="例如：我已关闭公告，当前已回到主页。"
                  />
                </label>
                <p className="helper">
                  你填写的补充会发送给模型，请勿填写密码或密钥。
                </p>
                <button
                  className="button"
                  disabled={unavailable || !feedback.trim()}
                  onClick={() =>
                    void act(async (current) => {
                      if (active) await api!.cancelFailureDiagnosis(requestId);
                      setAck(false);
                      const v = await api!.diagnoseFailure({
                        requestId,
                        feedback,
                      });
                      if (current()) setView(v);
                    })
                  }
                >
                  提交纠正并重新诊断
                </button>
              </>
            )}
            {s.status === "awaiting-user" &&
              s.diagnosis?.action === "retry-remaining" && (
                <div className="incident-confirm">
                  <label>
                    <input
                      type="checkbox"
                      checked={ack}
                      disabled={unavailable}
                      onChange={(e) => setAck(e.target.checked)}
                    />
                    我已核对截图与以上任务，确认按原进度继续。
                  </label>
                  <button
                    className="button primary"
                    disabled={unavailable || !ack}
                    onClick={() =>
                      void act(async (current) => {
                        const v =
                          await api!.confirmFailureContinuation(requestId);
                        if (current()) setView(v);
                      })
                    }
                  >
                    确认按原进度继续
                  </button>
                </div>
              )}
          </aside>
        </div>
      )}
    </section>
  );
}
