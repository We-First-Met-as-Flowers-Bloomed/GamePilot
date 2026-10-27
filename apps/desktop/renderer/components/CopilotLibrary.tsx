import { useRef, useState } from "react";
import { Search, Play, Square, FileCheck } from "lucide-react";
import type { DesktopController } from "../hooks/useDesktop";
import type { PreparedCopilotPlan } from "../../../../packages/protocol/copilot";
import type { CopilotJobSummary } from "../../../../games/arknights/copilot-library";

export default function CopilotLibrary({
  desktop,
  onRecords,
}: {
  desktop: DesktopController;
  onRecords: () => void;
}) {
  const { api, arknightsProfiles, deviceLanes, active, busy } = desktop;
  const [stage, setStage] = useState("1-7"),
    [count, setCount] = useState(1),
    [profileId, setProfileId] = useState("");
  const [results, setResults] = useState<CopilotJobSummary[]>([]),
    [prepared, setPrepared] = useState<PreparedCopilotPlan>(),
    [pending, setPending] = useState(false),
    [message, setMessage] = useState("");
  const [receipt, setReceipt] = useState<{
    batchId: string;
    requestId: string;
    laneId: string;
  }>();
  const flight = useRef(false);
  const profiles = arknightsProfiles.profiles.filter(
    (p) =>
      deviceLanes.lanes.filter(
        (l) =>
          l.enabled && l.arknights.enabled && l.arknights.profileId === p.id,
      ).length === 1,
  );
  const selected = profileId || profiles[0]?.id || "";
  const disabled =
    !api ||
    typeof api.prepareCopilot !== "function" ||
    pending ||
    active ||
    !!busy;
  const invalidate = () => {
    setPrepared(undefined);
    setReceipt(undefined);
    setMessage("");
  };
  async function act(action: () => Promise<void>) {
    if (flight.current || disabled) return;
    flight.current = true;
    setPending(true);
    setMessage("");
    try {
      await action();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      flight.current = false;
      setPending(false);
    }
  }
  return (
    <section className="surface copilot-library" aria-label="明日方舟临时作业">
      <div className="section-label">
        <h2>临时作业</h2>
        <span className="badge">实机验收待完成</span>
      </div>
      <p className="helper">
        查找并检查当前关卡的社区作业。每次独立确认1至3场，不使用理智药或源石。执行前核验UID与干员条件，结果以逐场原生证据和返回主页核验为准。
      </p>
      <div className="copilot-controls">
        <label>
          账号
          <select
            aria-label="作业账号"
            value={selected}
            disabled={disabled}
            onChange={(e) => {
              setProfileId(e.target.value);
              invalidate();
            }}
          >
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          关卡
          <input
            aria-label="作业关卡"
            value={stage}
            maxLength={64}
            disabled={disabled}
            onChange={(e) => {
              setStage(e.target.value);
              setResults([]);
              invalidate();
            }}
          />
        </label>
        <label>
          场数
          <select
            aria-label="作业场数"
            value={count}
            disabled={disabled}
            onChange={(e) => {
              setCount(Number(e.target.value));
              invalidate();
            }}
          >
            {[1, 2, 3].map((n) => (
              <option key={n} value={n}>
                {n}场
              </option>
            ))}
          </select>
        </label>
        <button
          className="button"
          disabled={disabled || !stage.trim()}
          onClick={() =>
            void act(async () => {
              setResults(await api!.searchCopilot({ stage, limit: 5 }));
              setMessage("搜索完成，尚未启动游戏。");
            })
          }
        >
          <Search size={14} />
          查找作业
        </button>
        <button
          className="button"
          disabled={disabled || !selected || !stage.trim()}
          onClick={() =>
            void act(async () => {
              setPrepared(undefined);
              setReceipt(undefined);
              setPrepared(
                await api!.prepareCopilot({
                  profileId: selected,
                  stage,
                  count,
                  skipStory: true,
                }),
              );
            })
          }
        >
          <FileCheck size={14} />
          检查本次作业
        </button>
      </div>
      {results.length > 0 && (
        <ul className="copilot-results">
          {results.map((r) => (
            <li key={r.id}>
              <strong>{r.title || `作业 ${r.id}`}</strong>
              <span className="muted">
                {" "}
                · {r.stageName} · #{r.id}
              </span>
            </li>
          ))}
        </ul>
      )}
      {prepared && !receipt && (
        <div
          className="copilot-review"
          role="region"
          aria-label="本次作业确认清单"
        >
          <h3>确认本次范围</h3>
          <p>
            {profiles.find((p) => p.id === prepared.account.profileId)?.name ??
              prepared.account.profileId}{" "}
            · {prepared.account.clientType} · UID尾号{" "}
            {prepared.account.expectedUid.slice(-4)} · {prepared.stage.code} ·{" "}
            {prepared.count}场
          </p>
          <p>理智药0 · 源石0 · 跳过剧情 · 未知结果不自动重跑</p>
          <ol>
            {prepared.jobs.map((j, i) => (
              <li key={i}>
                {j.title || `作业 ${j.id}`} · #{j.id}
                <small className="muted">
                  {" "}
                  · 内容哈希 {j.sha256.slice(0, 12)}
                </small>
              </li>
            ))}
          </ol>
          <p className="helper">
            干员预检尚未实机完成。专精或模组数据无法确认时将停止执行。准备记录10分钟内有效。
          </p>
          <button
            className="button primary"
            disabled={disabled}
            onClick={() =>
              void act(async () => {
                const r = await api!.confirmCopilot({
                  preparedId: prepared.preparedId,
                  planHash: prepared.planHash,
                  revision: prepared.revision,
                });
                setReceipt(r);
                setMessage(
                  "本次作业已受理，正在核验现场；受理不代表战斗完成。",
                );
              })
            }
          >
            <Play size={14} />
            确认本次执行
          </button>
        </div>
      )}
      {message && (
        <p role="status" className="helper">
          {message}
        </p>
      )}
      {receipt && (
        <div className="copilot-receipt">
          <p>执行记录：{receipt.requestId}</p>
          <button className="button" onClick={onRecords}>
            查看执行记录
          </button>
          <button
            className="button"
            disabled={!api || pending}
            onClick={() => {
              if (flight.current) return;
              flight.current = true;
              setPending(true);
              void api!
                .cancelCopilot(receipt)
                .then((r) => setMessage(r.message))
                .catch((e) => setMessage(String(e)))
                .finally(() => {
                  flight.current = false;
                  setPending(false);
                });
            }}
          >
            <Square size={14} />
            停止本次作业
          </button>
        </div>
      )}
    </section>
  );
}
