import { useState } from "react";
import FailureEvidencePanel from "./FailureEvidencePanel";
import ContinuationPanel from "./ContinuationPanel";
import type { DesktopAPI } from "../../../../packages/protocol";
import type { ExecutionRecord } from "../../../../packages/protocol/execution";
import type {
  RecoveryAssessment,
  DeviceInspection,
} from "../../../../packages/protocol/recovery";
import { games } from "../../../../games/registry";
import { arknightsPageLabels } from "../../../../games/arknights/inspection";
const labels: Record<string, string> = {
  succeeded: "执行器完成",
  skipped: "已跳过",
  failed: "失败，待核对",
  cancelled: "已停止，待核对",
  unknown: "结果未知",
  "not-run": "未执行",
  unrecorded: "缺少记录",
  running: "执行中",
  pending: "等待执行",
};
export default function RecoveryPanel({
  record,
  api,
  disabled,
  onResolved,
  onStarted,
}: {
  record: ExecutionRecord;
  api?: DesktopAPI;
  disabled?: boolean;
  onResolved?: (record: ExecutionRecord) => void;
  onStarted?: (id: string) => void;
}) {
  const [report, setReport] = useState<RecoveryAssessment>();
  const [inspection, setInspection] = useState<DeviceInspection>();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run(action: () => Promise<void>) {
    if (busy || disabled) return;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const unavailable = !api || busy || disabled;
  return (
    <div className="recovery-panel">
      <FailureEvidencePanel
        record={record}
        api={api}
        disabled={disabled || busy}
      />
      {record.resolution && (
        <p className="recovery-resolution">
          已结束此次处理，未标记任务成功 ·{" "}
          {new Date(record.resolution.at).toLocaleString("zh-CN")}
          <br />
          {record.resolution.note}
        </p>
      )}
      {!record.resolution && (
        <ContinuationPanel
          requestId={record.id}
          api={api}
          disabled={disabled || busy}
          onStarted={onStarted}
        />
      )}
      <div className="recovery-actions">
        <button
          className="button"
          disabled={unavailable}
          onClick={() =>
            void run(async () => {
              setReport(await api!.reviewExecution(record.id));
            })
          }
        >
          核对任务记录
        </button>
        {!record.resolution && (
          <button
            className="button"
            disabled={unavailable}
            onClick={() =>
              void run(async () => {
                setInspection(undefined);
                setInspection(await api!.inspectExecution(record.id));
              })
            }
          >
            读取当前现场
          </button>
        )}
        {busy && <span role="status">正在核对…</span>}
      </div>
      {error && <p role="alert">{error}</p>}
      {report && (
        <div className="recovery-report">
          {report.games.map((game, index) => (
            <details className="recovery-game" key={`${game.gameId}-${index}`}>
              <summary>
                {games.find((g) => g.id === game.gameId)?.name ?? game.gameId}
                {game.mode === "rehearsal" ? "（演练）" : ""}
                {` · ${game.steps.length} 项`}
                {game.steps.some((step) => step.status === "unrecorded")
                  ? " · 缺少记录"
                  : " · 展开核对步骤"}
              </summary>
              <ul>
                {game.steps.map((step) => (
                  <li key={step.skillId}>
                    <span>
                      {games
                        .find((g) => g.id === game.gameId)
                        ?.skills.find((s) => s.id === step.skillId)?.title ??
                        step.skillId}
                    </span>
                    <strong>{labels[step.status]}</strong>
                    <p>{step.message}</p>
                  </li>
                ))}
              </ul>
            </details>
          ))}
          <h3>原始记录核对</h3>
          <ul>
            {report.reasons.map((reason, i) => (
              <li key={i}>
                {games.reduce(
                  (text, game) => text.replaceAll(game.id, game.name),
                  reason,
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {inspection && (
        <figure className="recovery-scene">
          <figcaption>
            读取时间：{new Date(inspection.observedAt).toLocaleString("zh-CN")}{" "}
            · {inspection.address}
            <br />
            前台应用：{inspection.foregroundPackage ?? "未识别"}
            {inspection.arknights ? (
              <>
                <br />
                页面：{arknightsPageLabels[inspection.arknights.page]}
                {inspection.pageVerified ? "（两次读取一致）" : "（未确认）"}
                <br />
                账号：
                {
                  {
                    matched: "UID 匹配",
                    mismatch: "UID 不符",
                    unbound: "未绑定 UID",
                    unknown: "未核验",
                  }[inspection.arknights.account]
                }
                {inspection.arknights.observedUid &&
                  ` · 读取 UID ${inspection.arknights.observedUid}`}
                {inspection.arknights.expectedUid &&
                  ` · 预设 UID ${inspection.arknights.expectedUid}`}
                <br />
                {inspection.arknights.message}
              </>
            ) : (
              "。账号和页面尚未核验；截图仅供本次人工核对。"
            )}
            {inspection.recognitionError && (
              <>
                <br />
                识别未完成：{inspection.recognitionError}
              </>
            )}
            <br />
            现场结果仅对应上述读取时间；不会改变任务账本或自动续跑。
          </figcaption>
          <img
            src={inspection.image}
            alt="对应模拟器在核对时的画面，不代表任务已完成"
          />
        </figure>
      )}
      {report && !record.resolution && (
        <div className="recovery-close">
          <label>
            处置说明
            <textarea
              value={note}
              maxLength={1000}
              disabled={unavailable}
              onChange={(e) => setNote(e.target.value)}
              placeholder="例如：已查看现场，结束本轮，之后手动发起新任务"
            />
          </label>
          <p>
            只结束这条待处理事项，保留原始结果。不会重做任务，也不会更改今天的完成记录。
          </p>
          <button
            className="button"
            disabled={unavailable || !note.trim()}
            onClick={() =>
              void run(async () => {
                const updated = await api!.resolveExecution({
                  id: record.id,
                  note,
                });
                onResolved?.(updated);
              })
            }
          >
            结束此次处理，不续跑
          </button>
        </div>
      )}
    </div>
  );
}
