import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Play, Square } from "lucide-react";
import type { DesktopAPI } from "../../../../packages/protocol";
import {
  agentExecutionActive,
  type AgentExecutionTarget,
  type AgentExecutionView,
} from "../../../../packages/protocol/agent-execution";
import { games } from "../../../../games/registry";
import { presentAgentParameters } from "../../../../games/agent-presentation";

const statusLabel: Record<AgentExecutionView["status"], string> = {
  idle: "等待检查",
  checking: "检查中",
  ready: "等待你确认",
  blocked: "暂不能运行",
  starting: "正在受理",
  running: "执行中",
  stopping: "正在停止",
  succeeded: "执行流程结束",
  cancelled: "已停止",
  unknown: "结果待核对",
};
export function PlannerExecution({
  api,
  target,
  onOpenExecution,
}: {
  api?: DesktopAPI;
  target?: AgentExecutionTarget;
  onOpenExecution?: (id: string) => void;
}) {
  const [view, setView] = useState<AgentExecutionView>({
    revision: -1,
    status: "idle",
    message: "",
    lanes: [],
  });
  const [accepted, setAccepted] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [now, setNow] = useState(Date.now());
  const mounted = useRef(false);
  const pendingRef = useRef(false);
  const apply = (value: AgentExecutionView) => {
    if (mounted.current)
      setView((previous) =>
        value.revision >= previous.revision ? value : previous,
      );
  };
  useEffect(() => {
    if (!api) return;
    mounted.current = true;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const value = await api.agentExecutionSnapshot();
        if (!stopped) {
          apply(value);
          setConnected(true);
          setNow(Date.now());
        }
      } catch {
        if (!stopped) setConnected(false);
      }
      if (!stopped) timer = setTimeout(refresh, 1000);
    };
    void refresh();
    return () => {
      stopped = true;
      mounted.current = false;
      clearTimeout(timer);
    };
  }, [api]);
  useEffect(() => {
    setAccepted(false);
  }, [view.reviewId, target?.requestId, target?.planHash]);
  const perform = async (action: () => Promise<AgentExecutionView>) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError("");
    try {
      apply(await action());
    } catch {
      if (mounted.current)
        setError(
          "请求未完成，请查看当前执行状态；已提交的任务不会因重试而再次启动。",
        );
    } finally {
      pendingRef.current = false;
      if (mounted.current) setPending(false);
    }
  };
  const active = agentExecutionActive(view);
  const cancel = async () => {
    if (!api || !view.requestId || stopping) return;
    setStopping(true);
    setError("");
    try {
      apply(await api.cancelAgentExecution(view.requestId));
    } catch {
      if (mounted.current)
        setError("停止请求未完成，请查看账号状态并使用停止全部任务。");
    } finally {
      if (mounted.current) setStopping(false);
    }
  };
  const matches =
    target?.requestId === view.requestId && target?.planHash === view.planHash;
  const expired = Boolean(view.expiresAt && now >= Date.parse(view.expiresAt));
  const submitted = Boolean(matches && view.batchId);
  if (!target && view.status === "idle") return null;
  return (
    <section className="agent-execution" aria-label="确认运行 AI 草稿">
      <div className="section-label">
        <h3>
          <CheckCircle2 size={17} /> 确认运行
        </h3>
        <span className="badge">{statusLabel[view.status]}</span>
      </div>
      <p className="helper">
        先支持明日方舟。检查账号、UID
        绑定及今日记录后，由你确认本次任务；不修改每天 08:00 的计划。
      </p>
      <p className="helper">
        运行本次任务后，该设备当天的整套日常不会自动补跑，以免重复；其他未选任务需另行安排。
      </p>
      {view.message && <p role="status">{view.message}</p>}
      {!matches && view.status !== "idle" && (
        <p className="helper">
          下方为上次检查或提交的任务，与当前输入分开保留。
        </p>
      )}
      {view.lanes.length > 0 && (
        <div className="agent-draft-lanes">
          {view.lanes.map((lane) => (
            <article className="agent-draft-lane" key={lane.laneId}>
              <h4>
                {lane.name} · {lane.profileName}
              </h4>
              <p className="helper">
                MuMu 实例 {lane.instance} · 登录后核验已绑定 UID
              </p>
              <ol className="agent-step-list">
                {lane.skillIds.map((id) => (
                  <li key={id}>
                    {games
                      .find((g) => g.id === "arknights")
                      ?.skills.find((s) => s.id === id)?.title ?? id}
                  </li>
                ))}
              </ol>
              <dl className="agent-parameters">
                {presentAgentParameters("arknights", lane.parameters).map(
                  (field) => (
                    <div key={field.label}>
                      <dt>{field.label}</dt>
                      <dd>{field.value}</dd>
                    </div>
                  ),
                )}
              </dl>
              {lane.status && (
                <p className="helper">
                  {
                    {
                      running: "正在执行",
                      succeeded: "所选步骤流程结束",
                      failed: "执行失败",
                      cancelled: "已取消，请核对已执行步骤",
                      unknown: "结果不明，需要核对现场",
                    }[lane.status]
                  }
                </p>
              )}
              {lane.executionId &&
                (onOpenExecution ? (
                  <button
                    className="button"
                    onClick={() => onOpenExecution(lane.executionId!)}
                  >
                    查看任务详情
                  </button>
                ) : (
                  <p className="helper agent-execution-id">
                    任务记录：{lane.executionId}
                  </p>
                ))}
            </article>
          ))}
        </div>
      )}
      {matches && view.status === "ready" && (
        <>
          <p className="helper">
            {expired
              ? "确认卡已过期，请重新检查。"
              : "确认卡两分钟内有效，开始前会再次核对配置和记录。"}
          </p>
          <label className="agent-execution-consent">
            <input
              id="agent-execution-consent"
              type="checkbox"
              checked={accepted}
              onChange={(event) => setAccepted(event.target.checked)}
              disabled={pending || expired || !connected}
            />
            我已核对账号、任务与附带奖励，确认立即运行本次任务。
          </label>
        </>
      )}
      <div className="agent-execution-actions">
        {target && !active && !submitted && (
          <button
            id="agent-execution-review"
            className="button"
            disabled={!api || !connected || pending}
            onClick={() =>
              void perform(() => api!.reviewAgentExecution(target))
            }
          >
            检查执行条件
          </button>
        )}
        {matches && view.status === "ready" && (
          <button
            id="agent-execution-confirm"
            className="button primary"
            disabled={!api || !connected || pending || !accepted || expired}
            onClick={() =>
              void perform(() =>
                api!.confirmAgentExecution({
                  ...target!,
                  reviewId: view.reviewId!,
                }),
              )
            }
          >
            <Play size={14} />
            确认并运行本次任务
          </button>
        )}
        {(active || view.status === "ready") && (
          <button
            id="agent-execution-stop"
            className="button"
            disabled={!api || stopping}
            onClick={() => void cancel()}
          >
            <Square size={14} />
            {view.status === "ready" || view.status === "checking"
              ? "取消确认"
              : "停止本次任务"}
          </button>
        )}
      </div>
      {!connected && (
        <p role="alert" className="banner warning">
          无法读取执行状态，确认按钮暂不可用。
        </p>
      )}
      {error && (
        <p role="alert" className="banner warning">
          {error}
        </p>
      )}
    </section>
  );
}
