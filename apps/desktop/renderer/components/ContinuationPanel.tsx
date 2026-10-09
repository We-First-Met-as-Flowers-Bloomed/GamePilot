import { useLayoutEffect, useRef, useState } from "react";
import { games } from "../../../../games/registry";
import type { DesktopAPI } from "../../../../packages/protocol";
import type {
  ContinuationPreview,
  ContinuationSelection,
  ContinuationStep,
} from "../../../../packages/protocol/continuation";
import "./continuation.css";

const title = (step: ContinuationStep) =>
  games
    .find((game) => game.id === step.gameId)
    ?.skills.find((skill) => skill.id === step.skillId)?.title ?? step.skillId;
const selectable = (step: ContinuationStep) =>
  step.skillId !== "login" &&
  (step.status === "retry" || step.status === "pending");
const selected = (
  selections: ContinuationSelection[],
  step: ContinuationStep,
) =>
  selections.some(
    (selection) =>
      selection.gameId === step.gameId &&
      selection.skillIds.includes(step.skillId),
  );

/** Submit only reviewed business steps. Login is injected as a fresh prerequisite by main. */
export function continuationSelections(
  preview: ContinuationPreview,
  selections: ContinuationSelection[],
): ContinuationSelection[] {
  const result: ContinuationSelection[] = [];
  for (const step of preview.steps) {
    if (!selectable(step) || !selected(selections, step)) continue;
    let game = result.find((selection) => selection.gameId === step.gameId);
    if (!game) {
      game = { gameId: step.gameId, skillIds: [] };
      result.push(game);
    }
    if (!game.skillIds.includes(step.skillId)) game.skillIds.push(step.skillId);
  }
  return result;
}

export function ContinuationReview({
  preview,
  selections,
  acknowledged,
  disabled,
  onToggle,
  onAcknowledge,
  onSubmit,
  onStarted,
}: {
  preview: ContinuationPreview;
  selections: ContinuationSelection[];
  acknowledged: boolean;
  disabled: boolean;
  onToggle: (step: ContinuationStep, enabled: boolean) => void;
  onAcknowledge: (checked: boolean) => void;
  onSubmit: () => void;
  onStarted?: (id: string) => void;
}) {
  const count = continuationSelections(preview, selections).reduce(
    (sum, game) => sum + game.skillIds.length,
    0,
  );
  const blocked =
    disabled ||
    !preview.canContinue ||
    !!preview.reasons.length ||
    !!preview.successorId ||
    count === 0 ||
    (preview.needsAcknowledgement && !acknowledged);
  return (
    <div className="continuation-review">
      <p>
        <strong>{preview.laneName}</strong> · 所选 {count} 项
      </p>
      <p className="helper">
        已完成任务保留记录；只继续勾选的未完成任务。续跑前重新核对登录状态；明日方舟同时核验
        UID。
      </p>
      <ul className="continuation-steps">
        {preview.steps.map((step) => (
          <li
            key={`${step.gameId}-${step.skillId}`}
            data-continuation-status={step.status}
          >
            <div className="continuation-step-heading">
              {selectable(step) ? (
                <label>
                  <input
                    type="checkbox"
                    aria-label={`续跑${title(step)}`}
                    checked={selected(selections, step)}
                    disabled={
                      disabled ||
                      !preview.canContinue ||
                      !!preview.reasons.length ||
                      !!preview.successorId
                    }
                    onChange={(event) => onToggle(step, event.target.checked)}
                  />
                  {title(step)}
                </label>
              ) : (
                <span>{title(step)}</span>
              )}
              <span className="muted">
                {step.skillId === "login"
                  ? "必需前置 · 重新核验"
                  : {
                      retained: "保留已完成",
                      excluded: "保留购物事实，取消重做",
                      retry: "失败 · 默认重试，可取消",
                      pending: "尚未执行",
                      blocked: "暂不能继续",
                    }[step.status]}
              </span>
            </div>
            <p className="helper">
              {games.find((game) => game.id === step.gameId)?.name ??
                step.gameId}{" "}
              · {step.message}
            </p>
          </li>
        ))}
      </ul>
      {preview.reasons.length > 0 && (
        <ul className="continuation-reasons">
          {preview.reasons.map((reason, index) => (
            <li key={index}>{reason}</li>
          ))}
        </ul>
      )}
      {preview.successorId ? (
        <div className="continuation-created" role="status">
          <p>
            此请求已有后续任务：<code>{preview.successorId}</code>
          </p>
          {onStarted && (
            <button
              className="button"
              onClick={() => onStarted(preview.successorId!)}
            >
              查看后续任务
            </button>
          )}
        </div>
      ) : (
        <>
          {preview.needsAcknowledgement && (
            <label className="continuation-acknowledgement">
              <input
                type="checkbox"
                checked={acknowledged}
                disabled={
                  disabled || !preview.canContinue || !!preview.reasons.length
                }
                onChange={(event) => onAcknowledge(event.target.checked)}
              />
              我已查看现场，知晓失败步骤可能已部分执行，确认按以上选择继续。
            </label>
          )}
          <p className="helper">将创建新的执行请求，原请求仍保留原始结果。</p>
          <button className="button" disabled={blocked} onClick={onSubmit}>
            确认继续所选任务
          </button>
        </>
      )}
    </div>
  );
}

interface Props {
  requestId: string;
  api?: DesktopAPI;
  disabled?: boolean;
  /** Receipt accepted; refresh observers without navigating away from the parent. */
  onAccepted?: (id: string) => void;
  onStarted?: (id: string) => void;
}

export default function ContinuationPanel(props: Props) {
  // A new request owns new review state, even when it replaces an in-flight review.
  return <ContinuationController key={props.requestId} {...props} />;
}

function ContinuationController({
  requestId,
  api,
  disabled,
  onAccepted,
  onStarted,
}: Props) {
  const [preview, setPreview] = useState<ContinuationPreview>();
  const [selections, setSelections] = useState<ContinuationSelection[]>([]);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [successor, setSuccessor] = useState<string>();
  const active = useRef(true);
  const inFlight = useRef(false);
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const available = !!api?.previewContinuation && !!api?.startContinuation;
  const unavailable = !!disabled || busy || !available;

  async function review() {
    if (unavailable || inFlight.current || successor) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setPreview(undefined);
    setSelections([]);
    setAcknowledged(false);
    try {
      const result = await api!.previewContinuation(requestId);
      if (!active.current) return;
      if (result.parentId !== requestId)
        throw new Error("续跑预检与当前请求不匹配，请重新核对。");
      setPreview(result);
      setSelections(continuationSelections(result, result.defaults));
    } catch (cause) {
      if (active.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  }
  async function submit() {
    if (
      unavailable ||
      inFlight.current ||
      successor ||
      !preview ||
      !preview.canContinue ||
      preview.reasons.length ||
      preview.successorId ||
      (preview.needsAcknowledgement && !acknowledged)
    )
      return;
    const remaining = continuationSelections(preview, selections);
    if (!remaining.some((game) => game.skillIds.length)) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await api!.startContinuation({
        parentId: requestId,
        fingerprint: preview.fingerprint,
        selections: remaining,
        acknowledgePartial: acknowledged,
      });
      if (!active.current) return;
      setSuccessor(result.requestId);
      onAccepted?.(result.requestId);
    } catch (cause) {
      if (active.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  }
  function toggle(step: ContinuationStep, enabled: boolean) {
    if (unavailable || !preview || !selectable(step)) return;
    setSelections((current) => {
      const next = current.map((game) => ({
        ...game,
        skillIds: game.skillIds.filter(
          (id) => game.gameId !== step.gameId || id !== step.skillId,
        ),
      }));
      if (enabled) {
        let game = next.find((item) => item.gameId === step.gameId);
        if (!game) {
          game = { gameId: step.gameId, skillIds: [] };
          next.push(game);
        }
        game.skillIds.push(step.skillId);
      }
      return continuationSelections(preview, next);
    });
  }
  return (
    <section className="continuation-panel" aria-label="继续未完成任务">
      {successor ? (
        <div className="continuation-created" role="status">
          <p>
            已创建后续任务：<code>{successor}</code>。原请求保留原始结果。
          </p>
          {onStarted && (
            <button className="button" onClick={() => onStarted(successor)}>
              查看后续任务
            </button>
          )}
        </div>
      ) : (
        <>
          <button
            className="button"
            disabled={unavailable || !!preview?.successorId}
            onClick={() => void review()}
          >
            继续未完成任务
          </button>
          {busy && <p role="status">正在处理续跑请求…</p>}
          {error && <p role="alert">{error}</p>}
          {preview && (
            <ContinuationReview
              preview={preview}
              selections={selections}
              acknowledged={acknowledged}
              disabled={unavailable}
              onToggle={toggle}
              onAcknowledge={setAcknowledged}
              onSubmit={() => void submit()}
              onStarted={onStarted}
            />
          )}
        </>
      )}
    </section>
  );
}
