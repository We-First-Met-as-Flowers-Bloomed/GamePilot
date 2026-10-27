import { useRef, useState } from "react";
import type { DesktopAPI } from "../../../../packages/protocol";
import type { CopilotReview } from "../../../../packages/protocol/copilot-review";
export default function CopilotConfirmationCard({
  review,
  api,
  enabled,
  onOpenExecution,
}: {
  review: CopilotReview;
  api?: DesktopAPI;
  enabled: boolean;
  onOpenExecution: (id: string) => void;
}) {
  const [consent, setConsent] = useState(false),
    [pending, setPending] = useState(false),
    [message, setMessage] = useState("");
  const [receipt, setReceipt] = useState<{
    batchId: string;
    requestId: string;
    laneId: string;
  }>();
  const inFlight = useRef(false);
  async function confirm() {
    if (!api || !enabled || !consent || inFlight.current || receipt) return;
    inFlight.current = true;
    setPending(true);
    setMessage("");
    try {
      setReceipt(
        await api.confirmCopilot({
          preparedId: review.preparedId,
          planHash: review.planHash,
          revision: review.revision,
        }),
      );
      setMessage("已受理，现场核验仍在进行；受理不代表战斗完成。");
    } catch (e) {
      setMessage(String(e));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }
  return (
    <section className="copilot-review" aria-label="对话临时作业确认">
      <h3>本次临时作业</h3>
      <p>
        {review.laneName} · {review.clientType} · UID尾号 {review.uidTail} ·{" "}
        {review.stage} · {review.count}场
      </p>
      <p>理智药0 · 源石0 · 跳过剧情 · 未知结果不自动重跑</p>
      <ol>
        {review.jobs.map((j, i) => (
          <li key={i}>
            {j.title || `作业 ${j.id}`} · #{j.id} · 哈希 {j.sha256.slice(0, 12)}
          </li>
        ))}
      </ol>
      <p className="helper">
        实机验收待完成。执行前核验UID与干员条件；专精或模组信息无法确认时停止。
      </p>
      {!receipt && (
        <>
          <label>
            <input
              type="checkbox"
              checked={consent}
              disabled={!enabled || pending}
              onChange={(e) => setConsent(e.target.checked)}
            />
            我已核对账号、关卡、次数和资源范围
          </label>
          <button
            className="button primary"
            disabled={
              !api ||
              !enabled ||
              !consent ||
              pending ||
              Date.now() >= Date.parse(review.expiresAt)
            }
            onClick={() => void confirm()}
          >
            确认本次作业
          </button>
          {!enabled && (
            <p className="helper">
              历史或旧会话准备记录不能执行，请重新发送需求。
            </p>
          )}
        </>
      )}
      {receipt && (
        <>
          <button
            className="button"
            onClick={() => onOpenExecution(receipt.requestId)}
          >
            查看本次作业记录
          </button>
          <button
            className="button"
            disabled={!api || pending}
            onClick={() => {
              if (inFlight.current) return;
              inFlight.current = true;
              setPending(true);
              void api!
                .cancelCopilot(receipt)
                .then((r) => setMessage(r.message))
                .catch((e) => setMessage(String(e)))
                .finally(() => {
                  inFlight.current = false;
                  setPending(false);
                });
            }}
          >
            停止本次作业
          </button>
        </>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
