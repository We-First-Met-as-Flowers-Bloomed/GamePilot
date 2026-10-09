import { useEffect, useRef, useState } from "react";
import { ArrowRight, Bot, Clock3, Square } from "lucide-react";
import type { DesktopAPI } from "../../../../packages/protocol";
import {
  plannerActive,
  type PlannerProgress,
  type PlannerResult,
  type PlannerSource,
} from "../../../../packages/protocol/agent-planner";
import { games } from "../../../../games/registry";
import { presentAgentParameters } from "../../../../games/agent-presentation";
import { PlannerRecords } from "./PlannerRecords";
import { PlannerEvidence } from "./PlannerEvidence";
import { PlannerExecution } from "./PlannerExecution";
import { usePlanner } from "../hooks/usePlanner";
import {
  defaultPlannerTime,
  draftMatchesInput,
  plannerLocalTime,
  plannerTime,
} from "../planner-form";

const progressLabel = (progress?: PlannerProgress) =>
  progress?.phase === "tool"
    ? ({
        list_capabilities: "已查询可用游戏与任务",
        read_skill: "读取内置技能说明",
        get_environment: "已查询账号配置",
        compile_plan: "已校验计划草稿",
        get_run: "已查询历史记录",
        get_incident: "已查询故障证据",
      }[progress.tool!] ?? "正在查询工具")
    : {
        discovering: "正在准备模型服务",
        connecting: "正在连接当前模型服务",
        checking: "正在检查连接与工具权限",
        thinking: "正在分析需求",
      }[progress?.phase ?? "discovering"];
const examples = [
  "为两个演练账号安排明日方舟日常，LS-6，领取邮件，不用理智药或源石。",
  "两个演练账号先完成明日方舟日常，再完成阴阳师日常。",
  "查询演练账号 lane-a 最近任务是否全部完成，不要重跑。",
];

export function PlannerDraft({ result }: { result: PlannerResult }) {
  const draft = result.draft;
  if (!draft) return null;
  return (
    <div className="agent-draft" aria-label="计划草稿">
      <div className="section-label">
        <h3>待检查的计划草稿</h3>
        <span className="badge">
          {result.source !== "fixture"
            ? "当前配置 · 草稿"
            : "演练账号 · 未执行"}
        </span>
      </div>
      <p className="helper">
        计划时间：{plannerLocalTime(draft.at).replace("T", " ")}（北京时间）
      </p>
      <div className="agent-draft-lanes">
        {draft.lanes.map((lane) => (
          <article className="agent-draft-lane" key={lane.laneId}>
            <h3>
              {result.source !== "fixture"
                ? `MuMu 实例 ${lane.instance}`
                : `演练账号 ${lane.instance + 1}`}
              <span className="muted">{lane.laneId}</span>
            </h3>
            {lane.games.map((item, index) => {
              const game = games.find((g) => g.id === item.plan.gameId);
              return (
                <section key={item.plan.gameId} className="agent-draft-game">
                  <h4>
                    {index + 1}. {game?.name ?? item.plan.gameId}
                  </h4>
                  <ol className="agent-step-list">
                    {item.plan.skillIds.map((id) => (
                      <li key={id}>
                        {game?.skills.find((s) => s.id === id)?.title ?? id}
                      </li>
                    ))}
                  </ol>
                  <dl className="agent-parameters">
                    {presentAgentParameters(
                      item.plan.gameId,
                      item.parameters,
                    ).map((field) => (
                      <div key={field.label}>
                        <dt>{field.label}</dt>
                        <dd>{field.value}</dd>
                      </div>
                    ))}
                  </dl>
                  {item.excluded.length > 0 && (
                    <p className="helper">
                      本次排除：
                      {item.excluded
                        .map(
                          (id) =>
                            game?.skills.find((s) => s.id === id)?.title ?? id,
                        )
                        .join("、")}
                    </p>
                  )}
                  {item.notes.map((note, i) => (
                    <p className="helper" key={i}>
                      {note}
                    </p>
                  ))}
                </section>
              );
            })}
          </article>
        ))}
      </div>
      <div className="agent-checks">
        <h3>执行前仍需核对</h3>
        <ul>
          {[...draft.reasons, ...draft.preconditions].map((reason, i) => (
            <li key={i}>{reason}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export default function AgentPlanner({
  api,
  openRequested = false,
  onOpened,
  onOpenExecution,
}: {
  api: DesktopAPI | undefined;
  openRequested?: boolean;
  onOpened?: () => void;
  onOpenExecution?: (id: string) => void;
}) {
  const p = usePlanner(api);
  const [prompt, setPrompt] = useState("");
  const [source, setSource] = useState<PlannerSource>("fixture");
  const [localTime, setLocalTime] = useState(defaultPlannerTime);
  const [now, setNow] = useState(Date.now());
  const hydrated = useRef(false);
  const details = useRef<HTMLDetailsElement>(null);
  const promptInput = useRef<HTMLTextAreaElement>(null);
  const active = plannerActive(p.state);
  const disabled =
    active ||
    p.pending ||
    !p.ready ||
    !api ||
    p.state.error?.code === "SHUTDOWN_FAILED";
  function focusPrompt() {
    if (!details.current) return;
    window.scrollTo({
      top: window.scrollY + details.current.getBoundingClientRect().top - 24,
    });
    promptInput.current?.focus({ preventScroll: true });
  }
  useEffect(() => {
    if (!openRequested || !details.current) return;
    details.current.open = true;
    if (disabled) {
      details.current.querySelector("summary")?.focus();
      // Wait for the initial state before focusing an editable prompt.
      if (api && !p.ready) return;
    } else {
      focusPrompt();
    }
    onOpened?.();
  }, [openRequested, disabled, api, p.ready, onOpened]);
  useEffect(() => {
    if (!p.ready || hydrated.current) return;
    hydrated.current = true;
    if (p.state.prompt) setPrompt(p.state.prompt);
    if (p.state.at) setLocalTime(plannerLocalTime(p.state.at));
    if (p.state.source) setSource(p.state.source);
  }, [p.ready, p.state]);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  const current = draftMatchesInput(p.state, prompt, localTime, source);
  const seconds = p.state.startedAt
    ? Math.max(
        0,
        Math.floor(
          ((p.state.finishedAt ? Date.parse(p.state.finishedAt) : now) -
            Date.parse(p.state.startedAt)) /
            1000,
        ),
      )
    : 0;
  return (
    <details
      ref={details}
      className="surface agent-planner"
      id="agent-planner"
      onToggle={(event) => {
        if (event.currentTarget.open && !disabled) focusPrompt();
      }}
    >
      <summary>
        <span className="agent-planner-title">
          <Bot size={18} />
          <span>
            <strong>用 AI 规划日常</strong>
            <small>描述需求，先检查草稿与执行条件</small>
          </span>
        </span>
        <span className="badge">
          {active
            ? "正在规划"
            : source !== "fixture"
              ? "实验 · 当前配置"
              : "实验 · 演练账号"}
        </span>
      </summary>
      <div className="agent-planner-body">
        <p className="agent-scope">
          {source === "recorded"
            ? "只读当前配置及关联的任务账本，按原请求展示步骤；记录成功不等于今天全部完成或游戏奖励已领取。"
            : source === "fixture"
              ? "使用两个演练账号，描述需求后检查计划。"
              : "只读当前账号配置，使用编号表示槽位。未探测设备、未读取任务账本，无法判断今天是否完成。"}
          生成草稿不会启动游戏；当前配置的方舟草稿可在下方检查条件并确认本次执行。
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const at = plannerTime(localTime);
            if (at && !disabled) void p.start({ prompt, at, source });
          }}
        >
          <label className="agent-source" htmlFor="agent-source">
            规划使用的账号
            <select
              id="agent-source"
              value={source}
              disabled={disabled}
              onChange={(event) =>
                setSource(event.target.value as PlannerSource)
              }
            >
              <option value="fixture">演练账号</option>
              <option value="configured">当前账号配置（只读）</option>
              <option value="recorded">当前配置与任务记录（只读）</option>
            </select>
          </label>
          {source !== "fixture" && (
            <p className="helper">
              {source === "recorded" &&
                "另发送脱敏的执行日期、任务范围与步骤状态，不发送原始请求编号或日志。"}
              发送给当前模型服务：编号化槽位、游戏参数和任务开关。配置中的
              UID、昵称、安装路径和截图不发送；你输入的需求会原样发送。
            </p>
          )}
          <label className="agent-prompt-label" htmlFor="agent-prompt">
            你想安排什么任务？
          </label>
          <textarea
            ref={promptInput}
            id="agent-prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            maxLength={12000}
            required
            rows={3}
            disabled={disabled}
            placeholder="例如：两个账号刷 LS-6、收邮件，只使用现有理智。"
            aria-describedby="agent-scope-hint"
          />
          <div className="agent-examples" aria-label="示例需求">
            {[
              "双账号方舟日常",
              "两个游戏依次完成",
              source === "recorded"
                ? "查询最近执行结果"
                : source === "fixture"
                  ? "查询未完成记录"
                  : "查看已保存配置",
            ].map((title, i) => (
              <button
                type="button"
                key={title}
                className="button"
                disabled={disabled}
                onClick={() =>
                  setPrompt(
                    source === "recorded" && i === 2
                      ? "查询当前所有已启用槽位最近的执行记录，区分每日、单项与维护：分别是什么游戏日，原请求有哪些任务，哪些已完成、失败或无法确认？只读查询，不补跑。"
                      : source === "fixture"
                        ? examples[i]
                        : [
                            "按当前所有已启用槽位保存的明日方舟日常和参数生成草稿，不用任何理智药或源石。",
                            "按当前所有已启用槽位的配置，先安排明日方舟，再安排阴阳师日常；保留每个账号的任务开关。",
                            "查看当前已保存的账号槽位和游戏配置，不推断任务完成状态。",
                          ][i],
                  )
                }
              >
                {title}
              </button>
            ))}
          </div>
          <div className="agent-form-footer">
            <label htmlFor="agent-at">
              计划时间（北京时间）
              <input
                id="agent-at"
                type="datetime-local"
                value={localTime}
                onChange={(event) => setLocalTime(event.target.value)}
                required
                disabled={disabled}
              />
            </label>
            {active ? (
              <button
                type="button"
                className="button"
                onClick={() => void p.cancel()}
                disabled={p.pending || p.state.status === "cancelling"}
              >
                <Square size={14} />
                {p.state.status === "cancelling" ? "正在取消…" : "取消规划"}
              </button>
            ) : (
              <button
                type="submit"
                className="button primary"
                disabled={disabled || !prompt.trim() || !plannerTime(localTime)}
              >
                {p.pending ? "正在提交…" : "发送需求"}
                <ArrowRight size={15} />
              </button>
            )}
          </div>
          <p id="agent-scope-hint" className="helper">
            时间仅用于校验草稿，不会新增定时任务。需求将发送给“模型连接”中已保存的服务；请勿填写密码或密钥。
          </p>
        </form>
        {!api && <p className="banner warning">请在桌面应用中使用 AI 规划。</p>}
        {p.error && (
          <p role="alert" className="banner warning">
            {p.error}
          </p>
        )}
        <div className="agent-progress" role="status" aria-live="polite">
          {active && (
            <>
              <Clock3 size={15} />
              <span>
                {p.state.status === "cancelling"
                  ? "正在取消规划，完成清理后才能重新生成"
                  : progressLabel(p.state.progress)}
              </span>
              <span className="muted">{seconds} 秒</span>
            </>
          )}
          {p.state.status === "cancelled" && "规划已取消，没有执行游戏任务。"}
        </div>
        {active && (
          <p className="helper">
            通常需要 2–3
            分钟。可以切换页面，回来后继续查看；关闭应用会取消本轮规划。
          </p>
        )}
        {p.state.error && (
          <div className="banner warning" role="alert">
            <strong>未能完成规划</strong>
            <p>{p.state.error.message}</p>
            <small>错误编号：{p.state.error.code}</small>
          </div>
        )}
        {p.state.result && !current && (
          <p className="banner warning">
            需求或时间已修改，或切换了账号来源，请重新提交需求。
          </p>
        )}
        {p.state.result && current && !p.pending && (
          <div className="agent-result">
            <PlannerEvidence assessment={p.state.result.historyAssessment} />
            <div className="agent-explanation">
              <span className="eyebrow">
                {
                  {
                    draft: "草稿已生成",
                    question: "需要补充信息",
                    blocked: "当前无法满足",
                    answer: "查询说明",
                    "saved-daily": "等待日常检查",
                    "saved-both-games": "等待双游戏检查",
                  }[p.state.result.status]
                }
              </span>
              <p>{p.state.result.modelText}</p>
              <span className="helper">
                AI 说明 · 游戏完成状态以任务记录为准
              </span>
            </div>
            <PlannerDraft result={p.state.result} />
            <PlannerRecords records={p.state.result.records} />
            <details className="agent-trace">
              <summary>
                规划记录 · {p.state.result.trace.length} 次工具调用 · {seconds}{" "}
                秒
              </summary>
              <ol>
                {p.state.result.trace.map((item) => (
                  <li key={item.callId}>
                    {progressLabel({ phase: "tool", tool: item.tool })} ·{" "}
                    {item.success ? "返回结果" : `失败（${item.code}）`}
                  </li>
                ))}
              </ol>
              <p className="helper">
                模型：{p.state.result.model} · {p.state.result.codexVersion}
              </p>
            </details>
          </div>
        )}
        <PlannerExecution
          api={api}
          onOpenExecution={onOpenExecution}
          target={
            current &&
            p.state.status === "completed" &&
            p.state.result?.status === "draft" &&
            p.state.source !== "fixture" &&
            p.state.requestId &&
            p.state.result.draft?.planHash
              ? {
                  requestId: p.state.requestId,
                  planHash: p.state.result.draft.planHash,
                }
              : undefined
          }
        />
      </div>
    </details>
  );
}
