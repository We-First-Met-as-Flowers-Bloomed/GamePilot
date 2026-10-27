import { useEffect, useRef, useState } from "react";
import type { DesktopAPI } from "../../../../packages/protocol";
import type {
  ArknightsActivityCatalog,
  ArknightsActivityStage,
} from "../../../../packages/protocol/arknights-activity";
import type { ArknightsProfile } from "../../../../games/arknights/config";
import "./arknights-activity-stages.css";

interface Props {
  api: DesktopAPI | null | undefined;
  profile: ArknightsProfile;
  disabled: boolean;
  onChange(patch: Partial<ArknightsProfile>): void;
}

export default function ArknightsActivityStages(props: Props) {
  // Each account/client owns its transient catalog and pending requests.
  return (
    <ActivityStagesForProfile
      key={`${props.profile.id}:${props.profile.clientType}`}
      {...props}
    />
  );
}

function stageUnavailableReason(
  stage: ArknightsActivityStage,
): string | undefined {
  if (!stage.available) return stage.reason || "当前不可用";
  const start = Date.parse(stage.startsAt),
    end = Date.parse(stage.endsAt),
    now = Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
    return "活动时间信息无效";
  if (now < start) return "尚未开放";
  if (now >= end) return "活动已结束";
  return undefined;
}

function miniGameUnavailableReason(stage: ArknightsActivityStage) {
  return (
    stageUnavailableReason(stage) ||
    (!/^[A-Za-z][A-Za-z0-9_@-]{0,119}$/.test(stage.stage)
      ? "活动任务信息无效，请重新同步"
      : undefined)
  );
}

function ActivityStagesForProfile({ api, profile, disabled, onChange }: Props) {
  const [catalog, setCatalog] = useState<ArknightsActivityCatalog>();
  const [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    setCatalog(undefined);
    setError("");
    setLoading(false);
    return () => {
      generation.current++;
    };
  }, [api]);
  async function sync() {
    if (disabled || !api?.arknightsActivity || loading) return;
    const request = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const next = await api.arknightsActivity({
        clientType: profile.clientType,
        refresh: true,
      });
      if (request === generation.current) setCatalog(next);
    } catch (error) {
      if (request === generation.current)
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }
  return (
    <details className="advanced-options ark-activity-stages">
      <summary>活动关卡与小游戏</summary>
      <p className="muted">
        同步 MAA 官方列表，选择开放关卡后加入作战队列，保存后生效。
      </p>
      <button
        className="button"
        type="button"
        disabled={disabled || loading || !api?.arknightsActivity}
        onClick={() => void sync()}
      >
        {loading ? "正在同步…" : "同步活动关卡"}
      </button>
      {error && <p role="alert">{error}</p>}
      {catalog && (
        <>
          <p role="status" className="muted">
            {catalog.message}
            {catalog.stale ? " · 使用缓存" : ""}
          </p>
          {catalog.stages.map((stage) => {
            const unavailable = stageUnavailableReason(stage);
            return (
              <div
                className="setting-row"
                key={`${stage.activity}:${stage.stage}`}
                data-activity-stage={stage.stage}
              >
                <span className="ark-activity-description">
                  {stage.label} · {stage.activity}
                  <small className="muted">
                    {unavailable ||
                      `截止 ${new Date(stage.endsAt).toLocaleString("zh-CN")}`}
                  </small>
                </span>
                <button
                  type="button"
                  className="button"
                  aria-label={`加入关卡 ${stage.label} 到作战队列`}
                  disabled={disabled || loading || !!unavailable}
                  onClick={() => {
                    // Cached activity data can expire while this panel remains open.
                    if (disabled || loading || stageUnavailableReason(stage))
                      return;
                    const stages = [
                      profile.stage,
                      ...(profile.taskOptions?.fight?.stages ?? []),
                    ].filter(Boolean);
                    const next = [...new Set([...stages, stage.stage])];
                    onChange({
                      stage: next[0],
                      taskOptions: {
                        ...profile.taskOptions,
                        fight: { ...profile.taskOptions?.fight, stages: next },
                      },
                    });
                  }}
                >
                  加入队列
                </button>
              </div>
            );
          })}
          <div
            className="ark-activity-mini-games"
            role="group"
            aria-label="官方活动小游戏"
          >
            <p className="ark-activity-heading">官方活动小游戏</p>
            <p className="muted">
              仅可选择目录中已开放且与当前内核兼容的任务；选择后保存账号参数，并在自动计划中选择“活动小游戏”。
            </p>
            {!catalog.miniGames?.length && (
              <p className="muted">当前目录没有小游戏任务。</p>
            )}
            {catalog.miniGames?.map((game) => {
              const unavailable = miniGameUnavailableReason(game);
              const selected =
                profile.extendedOptions?.customActivity?.route === game.stage;
              return (
                <div
                  className="setting-row"
                  key={`${game.activity}:${game.stage}`}
                  data-activity-mini-game={game.stage}
                >
                  <span className="ark-activity-description">
                    {game.label} · {game.activity}
                    <small className="muted">
                      {unavailable ||
                        `截止 ${new Date(game.endsAt).toLocaleString("zh-CN")}`}
                    </small>
                    {game.tip && <small className="muted">{game.tip}</small>}
                  </span>
                  <button
                    type="button"
                    className="button"
                    aria-label={`选择活动小游戏 ${game.label}`}
                    aria-pressed={selected}
                    disabled={disabled || loading || !!unavailable}
                    onClick={() => {
                      if (
                        disabled ||
                        loading ||
                        miniGameUnavailableReason(game)
                      )
                        return;
                      onChange({
                        extendedOptions: {
                          ...profile.extendedOptions,
                          customActivity: {
                            ...profile.extendedOptions?.customActivity,
                            route: game.stage,
                          },
                        },
                      });
                    }}
                  >
                    {selected ? "已选择" : "选择小游戏"}
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}
    </details>
  );
}
