import { useEffect, useRef, useState } from "react";
import { Archive, ChevronDown, Clock3 } from "lucide-react";
import type { DesktopAPI } from "../../../../packages/protocol";
import type {
  ChatArchiveEntry,
  ChatArchiveTurnsPage,
  ChatSession,
  ChatSessionSummary,
} from "../../../../packages/protocol/agent-chat";
import { chatTurnLabel } from "../chat-state";
import { PlannerDraft } from "./AgentPlanner";
import { PlannerRecords } from "./PlannerRecords";
const sources = {
  recorded: "当前账号与记录",
  configured: "当前账号配置",
  fixture: "演练账号",
};
const conclusions: Record<string, string> = {
  unknown: "结果未知",
  failed: "失败",
  cancelled: "已取消",
  "recorded-plan-complete": "原请求记录完整",
};

export function ChatSessionSummaryCard({
  summary,
}: {
  summary?: ChatSessionSummary;
}) {
  if (!summary || (!summary.objectives.length && !summary.facts.length))
    return null;
  return (
    <details className="chat-response-details chat-session-summary">
      <summary>
        <Clock3 size={14} />
        会话目标与已核对事实<span>历史引用</span>
        <ChevronDown size={14} />
      </summary>
      <div className="chat-summary-body">
        <p className="helper">
          摘要按原始需求和宿主工具回执生成。当前状态仍需本轮工具核对，历史摘要不授予执行权限。
        </p>
        <h4>目标与约束</h4>
        <ul>
          {summary.objectives.slice(-6).map((item) => (
            <li key={item.turnId}>
              <p>{item.text}</p>
              <small>
                {sources[item.source]} · 原轮次 {item.turnId}
                {item.truncated ? " · 完整需求见原聊天记录" : ""}
              </small>
            </li>
          ))}
        </ul>
        {summary.facts.length > 0 && (
          <>
            <h4>宿主已读取的历史事实</h4>
            <ul>
              {summary.facts.slice(-8).map((fact, index) => (
                <li key={`${fact.turnId}-${index}`}>
                  <p>
                    {fact.kind === "recorded-run"
                      ? `${fact.requestId} · ${conclusions[fact.recordedConclusion ?? ""] ?? fact.recordedConclusion ?? "结果未知"}`
                      : "曾生成计划草稿，未授予执行权限"}
                  </p>
                  <small>
                    {sources[fact.source]} · {fact.originTool} ·{" "}
                    {new Date(fact.at).toLocaleString("zh-CN", {
                      hour12: false,
                    })}
                  </small>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </details>
  );
}
export function ChatArchiveTranscript({
  page,
}: {
  page: ChatArchiveTurnsPage;
}) {
  return (
    <section className="chat-archive-transcript" aria-label="只读归档对话">
      <header>
        <strong>{page.session.title}</strong>
        <span>只读历史 · {page.archive.turnCount} 轮</span>
      </header>
      <p className="helper">
        保留原始需求、模型答复和数据来源。旧草稿只供查看，要运行须在当前会话重新检查。
      </p>
      <ChatSessionSummaryCard summary={page.session.summary} />
      {page.turns.map((turn) => (
        <article className="chat-archive-turn" key={turn.id}>
          <p className="chat-archive-prompt">{turn.prompt}</p>
          <small>
            {sources[turn.source]} ·{" "}
            {new Date(turn.createdAt).toLocaleString("zh-CN", {
              hour12: false,
            })}
          </small>
          <p className="chat-archive-answer">
            {turn.planner.result?.modelText ??
              turn.planner.error?.message ??
              chatTurnLabel(turn.planner)}
          </p>
          {turn.planner.result?.draft && (
            <details className="chat-response-details">
              <summary>
                旧计划草稿 · 只读
                <ChevronDown size={14} />
              </summary>
              <PlannerDraft result={turn.planner.result} />
            </details>
          )}
          <PlannerRecords records={turn.planner.result?.records} />
        </article>
      ))}
    </section>
  );
}

export default function ChatArchives({
  api,
  session,
  pending: chatPending,
  active,
  onArchive,
}: {
  api?: DesktopAPI;
  session?: ChatSession;
  pending: boolean;
  active: boolean;
  onArchive?: (sessionId: string) => Promise<boolean>;
}) {
  const [entries, setEntries] = useState<ChatArchiveEntry[]>([]),
    [nextCursor, setNextCursor] = useState<string>(),
    [page, setPage] = useState<ChatArchiveTurnsPage>(),
    [pending, setPending] = useState(false),
    [error, setError] = useState(""),
    [opened, setOpened] = useState(false);
  const epoch = useRef(0),
    detailEpoch = useRef(0),
    working = useRef(false);
  const supported =
    api &&
    typeof api.listArchivedChats === "function" &&
    typeof api.loadArchivedChat === "function" &&
    typeof api.archiveChat === "function";
  useEffect(() => {
    epoch.current++;
    detailEpoch.current++;
    setEntries([]);
    setPage(undefined);
    setNextCursor(undefined);
    setError("");
    working.current = false;
    setPending(false);
    setOpened(false);
    return () => {
      epoch.current++;
      detailEpoch.current++;
    };
  }, [api]);
  async function perform(job: () => Promise<void>) {
    if (working.current) return;
    const generation = epoch.current;
    working.current = true;
    setPending(true);
    setError("");
    try {
      await job();
    } catch (reason) {
      if (generation === epoch.current)
        setError(
          reason instanceof Error
            ? reason.message
            : "无法读取会话归档，原记录保留。",
        );
    } finally {
      if (generation === epoch.current) {
        working.current = false;
        setPending(false);
      }
    }
  }
  async function list(more = false) {
    if (!supported) return;
    const generation = epoch.current;
    const result = await api.listArchivedChats({
      limit: 8,
      ...(more && nextCursor ? { cursor: nextCursor } : {}),
    });
    if (generation !== epoch.current) return;
    setEntries((previous) => [
      ...new Map(
        [...(more ? previous : []), ...result.entries].map((entry) => [
          entry.id,
          entry,
        ]),
      ).values(),
    ]);
    setNextCursor(result.nextCursor);
  }
  async function load(id: string, more = false) {
    if (!supported) return;
    const generation = ++detailEpoch.current;
    if (!more) setPage(undefined);
    const result = await api.loadArchivedChat({
      archiveId: id,
      limit: 8,
      ...(more && page?.nextCursor ? { cursor: page.nextCursor } : {}),
    });
    if (generation !== detailEpoch.current) return;
    setPage((previous) =>
      more && previous?.archive.id === id
        ? {
            ...result,
            turns: [
              ...new Map(
                [...previous.turns, ...result.turns].map((turn) => [
                  turn.id,
                  turn,
                ]),
              ).values(),
            ],
          }
        : result,
    );
  }
  return (
    <details
      className="chat-response-details chat-archives"
      onToggle={(event) => {
        if (event.currentTarget.open && !opened) {
          setOpened(true);
          void perform(() => list());
        }
      }}
    >
      <summary>
        <Archive size={14} />
        会话记录与归档<span>保留原文 · 分页查看</span>
        <ChevronDown size={14} />
      </summary>
      <div className="chat-archives-body">
        {!supported ? (
          <p className="helper">
            归档功能需桌面 App，当前预览继续保留已有聊天记录。
          </p>
        ) : (
          <>
            <div className="chat-archive-current">
              <div>
                <strong>当前会话</strong>
                <p>{session?.title ?? "未选择会话"}</p>
                <small>
                  32 个会话 / 每会话 64 轮预算，归档后可继续新会话。
                </small>
              </div>
              <button
                type="button"
                className="button"
                disabled={
                  pending ||
                  chatPending ||
                  active ||
                  !session?.turns.length ||
                  !onArchive
                }
                onClick={() => {
                  if (!session || !onArchive) return;
                  void perform(async () => {
                    if (await onArchive(session.id)) await list();
                    else
                      throw Error(
                        "归档未完成，请查看当前会话状态；原记录保留。",
                      );
                  });
                }}
              >
                归档当前会话
              </button>
            </div>
            {active && (
              <p className="helper">本会话仍在处理，结束后可手动归档。</p>
            )}
            {error && (
              <p role="alert" className="banner warning">
                {error}
              </p>
            )}
            {pending && (
              <p role="status" className="helper">
                正在读取或保存归档…
              </p>
            )}
            <div className="chat-archive-list">
              {entries.map((entry) => (
                <button
                  type="button"
                  className={page?.archive.id === entry.id ? "selected" : ""}
                  key={entry.id}
                  disabled={pending}
                  onClick={() => void perform(() => load(entry.id))}
                >
                  <span>{entry.title}</span>
                  <small>
                    {entry.turnCount} 轮 ·{" "}
                    {entry.sources
                      .map((source) => sources[source])
                      .join("、") || "空会话"}{" "}
                    · {new Date(entry.archivedAt).toLocaleDateString("zh-CN")}
                  </small>
                </button>
              ))}
            </div>
            {!entries.length && !pending && !error && (
              <p className="helper">
                尚无归档会话。归档保留完整原文，历史不会自动发送或执行。
              </p>
            )}
            {nextCursor && (
              <button
                type="button"
                className="text-button"
                disabled={pending}
                onClick={() => void perform(() => list(true))}
              >
                更多归档会话
              </button>
            )}
            {page && (
              <>
                <ChatArchiveTranscript page={page} />
                {page.nextCursor && (
                  <button
                    className="text-button"
                    type="button"
                    disabled={pending}
                    onClick={() =>
                      void perform(() => load(page.archive.id, true))
                    }
                  >
                    继续读取归档对话
                  </button>
                )}
              </>
            )}
          </>
        )}
      </div>
    </details>
  );
}
