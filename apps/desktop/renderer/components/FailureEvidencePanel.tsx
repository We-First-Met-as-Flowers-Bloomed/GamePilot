import { useState } from "react";
import type { DesktopAPI } from "../../../../packages/protocol";
import type { ExecutionRecord } from "../../../../packages/protocol/execution";
import {
  failureLabels,
  type FailureEvidenceSummary,
  type FailureImageView,
} from "../../../../packages/protocol/failure-view";
import { startupFaultLabels } from "../../../../packages/protocol/startup-fault";
import { games } from "../../../../games/registry";

export default function FailureEvidencePanel({
  record,
  api,
  disabled,
}: {
  record: ExecutionRecord;
  api?: DesktopAPI;
  disabled?: boolean;
}) {
  const [items, setItems] = useState<FailureEvidenceSummary[]>();
  const [images, setImages] = useState<Record<string, FailureImageView>>({});
  const [confirm, setConfirm] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function act(action: () => Promise<void>) {
    if (!api || busy || disabled) return;
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
    <section className="failure-evidence" aria-label="历史失败证据">
      <div className="recovery-actions">
        <button
          className="button"
          disabled={unavailable}
          onClick={() =>
            void act(async () =>
              setItems(await api!.failureEvidence(record.id)),
            )
          }
        >
          查看失败证据
        </button>
        {busy && <span role="status">正在读取本地证据…</span>}
      </div>
      {record.startupFault && (
        <p>
          启动阶段 · {startupFaultLabels[record.startupFault.code]} ·{" "}
          {new Date(record.startupFault.observedAt).toLocaleString("zh-CN")}
          <br />
          当时尚未确认设备就绪，没有游戏截图。
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {items && (
        <>
          <p className="helper">
            以下是失败时保存的历史证据，仅在本机查看。图片可能含账号信息；不会发送给
            AI，也不代表当前现场。
          </p>
          {!items.length && (
            <p>没有任务步骤的失败证据。旧记录或启动前中断可能未采集截图。</p>
          )}
          {items.map((item) => {
            const game = games.find((g) => g.id === item.gameId),
              image = images[item.runId];
            return (
              <div className="failure-evidence-item" key={item.runId}>
                <strong>
                  {game?.name ?? item.gameId} ·{" "}
                  {game?.skills.find((s) => s.id === item.skillId)?.title ??
                    item.skillId ??
                    "执行器"}
                </strong>
                <p>
                  {failureLabels[item.code]} ·{" "}
                  {new Date(item.observedAt).toLocaleString("zh-CN")}
                </p>
                {item.captureStatus !== "stored" ? (
                  <p>
                    {item.captureStatus === "unavailable"
                      ? "当时截图未能保存"
                      : "当时未尝试截图"}
                  </p>
                ) : (
                  <>
                    <div className="recovery-actions">
                      <button
                        className="button"
                        disabled={unavailable}
                        onClick={() =>
                          void act(async () => {
                            const value = await api!.readFailureImage({
                              requestId: record.id,
                              runId: item.runId,
                            });
                            setImages((previous) => ({
                              ...previous,
                              [item.runId]: value,
                            }));
                          })
                        }
                      >
                        查看失败截图
                      </button>
                      {image?.status === "available" && (
                        <button
                          className="button"
                          disabled={unavailable}
                          onClick={() => setConfirm(item.runId)}
                        >
                          删除本地截图
                        </button>
                      )}
                    </div>
                    {image?.status === "missing" && (
                      <p role="status">
                        本地截图已删除或不存在，原失败记录仍保留。
                      </p>
                    )}
                    {image?.status === "not-captured" && (
                      <p>此记录没有截图。</p>
                    )}
                    {image?.status === "available" && (
                      <figure className="recovery-scene">
                        <figcaption>
                          失败时画面 ·{" "}
                          {new Date(item.observedAt).toLocaleString("zh-CN")} ·
                          历史截图
                        </figcaption>
                        <img
                          src={image.image}
                          alt={`${game?.name ?? item.gameId} 失败时保存的历史截图`}
                        />
                      </figure>
                    )}
                    {confirm === item.runId && (
                      <div className="failure-delete-confirm">
                        <p>
                          删除这张截图后无法恢复。任务结果、故障摘要和每日完成记录会保留。
                        </p>
                        <div className="recovery-actions">
                          <button
                            className="button"
                            disabled={unavailable}
                            onClick={() =>
                              void act(async () => {
                                await api!.deleteFailureImage({
                                  requestId: record.id,
                                  runId: item.runId,
                                });
                                setImages((previous) => ({
                                  ...previous,
                                  [item.runId]: { status: "missing" },
                                }));
                                setConfirm(undefined);
                              })
                            }
                          >
                            确认删除截图
                          </button>
                          <button
                            className="button"
                            disabled={unavailable}
                            onClick={() => setConfirm(undefined)}
                          >
                            保留截图
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </>
      )}
    </section>
  );
}
