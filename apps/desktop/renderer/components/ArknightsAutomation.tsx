import {
  ONMYOJI_AUTOMATION_SKILLS,
  ONMYOJI_DAILY_SKILLS,
} from "../../../../packages/protocol/onmyoji-automation";
import { onmyoji } from "../../../../games/onmyoji";
import {
  ARKNIGHTS_AUTOMATION_SKILLS,
  ARKNIGHTS_DAILY_SKILLS,
} from "../../../../packages/protocol/arknights-automation";
import type { ArknightsAutomationController } from "../hooks/useArknightsAutomation";
import "./arknights-automation.css";

export {
  createArknightsAutomationController,
  useArknightsAutomation,
} from "../hooks/useArknightsAutomation";

const weekdays = [
  [1, "一"],
  [2, "二"],
  [3, "三"],
  [4, "四"],
  [5, "五"],
  [6, "六"],
  [0, "日"],
] as const;
const skillLabels: Record<string, string> = {
  login: "登录游戏",
  recruit: "公开招募",
  fight: "自动刷关",
  infrastructure: "基建换班",
  friends: "访问好友",
  award: "领取奖励",
  depot: "仓库识别",
  "operator-box": "干员识别",
  "recruit-recognition": "公招识别",
  copilot: "自动战斗作业",
  roguelike: "集成战略",
  reclamation: "生息演算",
  "sss-copilot": "保全作业",
  "paradox-copilot": "悖论模拟作业",
  "switch-theme": "切换主页主题",
  "video-recognition": "录像识别",
  "activity-game": "活动小游戏",
  "operator-progress": "干员养成",
};
const onmyojiLabels = Object.fromEntries(
  onmyoji.skills.map((skill) => [skill.id, skill.title]),
);

export function ArknightsAutomationControls({
  controller: c,
  disabled = false,
}: {
  controller: ArknightsAutomationController;
  disabled?: boolean;
}) {
  if (!c.available) return null;
  const title = c.title;
  if (!c.loaded || !c.config)
    return (
      <div className="ark-automation-controls">
        <p className="helper" role={c.error ? "alert" : "status"}>
          {c.message || `正在读取${title}自动计划…`}
        </p>
        {c.error && (
          <button
            type="button"
            className="button"
            disabled={c.busy}
            onClick={() => void c.load()}
          >
            重新读取
          </button>
        )}
      </div>
    );
  return (
    <section
      className="ark-automation-controls"
      aria-label={`${title}自动计划设置`}
    >
      <div className="ark-automation-toolbar">
        <div>
          <h3>{title}自动计划</h3>
          <p className="helper">
            各账号独立设置时间与步骤，使用电脑本地时间。
            {c.dirty ? "有修改待保存。" : "已保存。"}
            {c.gameId === "onmyoji" &&
              "首次启用从下一时段开始，已过去时段不会补跑。"}
          </p>
        </div>
        <button
          type="button"
          className="button"
          role="switch"
          aria-label={`启用${title}自动计划`}
          aria-checked={c.config.enabled}
          disabled={disabled || c.busy}
          onClick={() => c.setEnabled(!c.config!.enabled)}
        >
          自动调度{c.config.enabled ? "已启用" : "已暂停"}
        </button>
        <button
          type="button"
          className="button primary"
          disabled={disabled || c.busy || !c.dirty}
          onClick={() => void c.save()}
        >
          {c.busy ? "处理中…" : "保存自动计划"}
        </button>
      </div>
      <p className="helper">
        自动调度开关控制全部{title}
        计划；暂停时仍可手动运行已保存的计划。应用需保持运行，电脑关机或睡眠期间不执行。
      </p>
      {c.message && (
        <p
          className={c.error ? "ark-automation-error" : "helper"}
          role={c.error ? "alert" : "status"}
        >
          {c.message}
        </p>
      )}
    </section>
  );
}

export default function ArknightsAutomation({
  laneId,
  laneName,
  controller: c,
  disabled = false,
  onOpenSettings,
}: {
  laneId: string;
  laneName: string;
  controller: ArknightsAutomationController;
  disabled?: boolean;
  onOpenSettings(): void;
}) {
  const isArk = c.gameId === "arknights";
  const labels = isArk ? skillLabels : onmyojiLabels;
  const dailySkills: readonly string[] = isArk
    ? ARKNIGHTS_DAILY_SKILLS
    : ONMYOJI_DAILY_SKILLS;
  const advancedSkills = (
    isArk ? ARKNIGHTS_AUTOMATION_SKILLS : ONMYOJI_AUTOMATION_SKILLS
  ).filter((skill) => !dailySkills.includes(skill));
  const locked = disabled || c.busy || !c.loaded;
  if (!c.available || !c.loaded || !c.config)
    return (
      <div className="ark-automation" data-arknights-automation-lane={laneId}>
        <p className="helper">
          {!c.available
            ? `当前版本暂不支持${c.title}自动计划`
            : c.error
              ? "自动计划读取失败，请在上方重试"
              : "正在读取自动计划…"}
        </p>
      </div>
    );
  const jobs = c.config.jobs.filter((job) => job.laneId === laneId);
  return (
    <section
      className="ark-automation"
      data-arknights-automation-lane={laneId}
      aria-label={`${laneName}自动计划`}
    >
      <div className="ark-automation-heading">
        <h3>
          自动计划 <span className="muted">{jobs.length}</span>
        </h3>
        <button
          type="button"
          className="text-button"
          disabled={locked || c.config.jobs.length >= 128}
          onClick={() => c.addJob(laneId, laneName)}
        >
          添加计划
        </button>
      </div>
      {!jobs.length && (
        <p className="helper">还没有自动计划。可为此账号添加多个时段。</p>
      )}
      <div className="ark-automation-jobs">
        {jobs.map((job) => (
          <div className="ark-automation-job" key={job.id} data-job-id={job.id}>
            <div className="ark-automation-heading">
              <div className="ark-automation-title">
                <time>{job.time}</time>
                <strong>{job.name || "未命名计划"}</strong>
                <span className="helper">
                  {job.enabled ? "已启用" : "已暂停"}
                </span>
              </div>
              <button
                type="button"
                className="button"
                disabled={locked || c.dirty}
                title={c.dirty ? "请先保存自动计划" : `运行${job.name}`}
                onClick={() => void c.runNow(laneId, job.id)}
              >
                立即运行
              </button>
            </div>
            <details className="ark-automation-job-details">
              <summary>
                编辑计划 ·{" "}
                {job.weekdays.length === 7
                  ? "每天"
                  : `周${
                      weekdays
                        .filter(([day]) => job.weekdays.includes(day))
                        .map(([, label]) => label)
                        .join("、") || "未选择星期"
                    }`}{" "}
                · {job.skillIds.length} 项任务
              </summary>
              <fieldset disabled={locked}>
                <div className="ark-automation-fields">
                  <label>
                    计划名称
                    <input
                      aria-label={`${laneName} ${job.id} 计划名称`}
                      maxLength={80}
                      value={job.name}
                      onChange={(event) =>
                        c.patchJob(laneId, job.id, { name: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    执行时间
                    <input
                      type="time"
                      aria-label={`${laneName} ${job.id} 执行时间`}
                      required
                      value={job.time}
                      onChange={(event) =>
                        c.patchJob(laneId, job.id, { time: event.target.value })
                      }
                    />
                  </label>
                </div>
                <div
                  className="ark-automation-options"
                  role="group"
                  aria-label={`${job.name}执行星期`}
                >
                  <span className="ark-automation-label">星期</span>
                  {weekdays.map(([day, label]) => (
                    <button
                      key={day}
                      type="button"
                      className="ark-automation-choice"
                      aria-label={`周${label}`}
                      aria-pressed={job.weekdays.includes(day)}
                      onClick={() =>
                        c.patchJob(laneId, job.id, {
                          weekdays: job.weekdays.includes(day)
                            ? job.weekdays.filter((value) => value !== day)
                            : [...job.weekdays, day],
                        })
                      }
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div
                  className="ark-automation-options"
                  role="group"
                  aria-label={`${job.name}任务步骤`}
                >
                  <span className="ark-automation-label">任务步骤</span>
                  {dailySkills.map((skill) => (
                    <button
                      type="button"
                      key={skill}
                      className="ark-automation-choice"
                      aria-pressed={job.skillIds.includes(skill)}
                      onClick={() =>
                        c.patchJob(laneId, job.id, {
                          skillIds: job.skillIds.includes(skill)
                            ? job.skillIds.filter((value) => value !== skill)
                            : [...job.skillIds, skill],
                        })
                      }
                    >
                      {labels[skill]}
                    </button>
                  ))}
                </div>
                <details className="ark-automation-job-details">
                  <summary>高级任务（按需选择）</summary>
                  <p className="helper">
                    需先配置账号参数；内核已接入，待本机实机验证。仅在明确选择并保存后加入本计划。
                  </p>
                  <div
                    className="ark-automation-options"
                    role="group"
                    aria-label={`${job.name}高级任务`}
                  >
                    {advancedSkills.map((skill) => (
                      <button
                        type="button"
                        key={skill}
                        className="ark-automation-choice"
                        aria-pressed={job.skillIds.includes(skill)}
                        onClick={() =>
                          c.patchJob(laneId, job.id, {
                            skillIds: job.skillIds.includes(skill)
                              ? job.skillIds.filter((value) => value !== skill)
                              : [...job.skillIds, skill],
                          })
                        }
                      >
                        {labels[skill]}
                      </button>
                    ))}
                  </div>
                </details>
                {!!job.skillIds.length && (
                  <ol
                    className="ark-automation-order"
                    aria-label="任务执行顺序"
                  >
                    {job.skillIds.map((skill, index) => (
                      <li key={skill}>
                        <span>{labels[skill]}</span>
                        <button
                          type="button"
                          className="text-button"
                          aria-label={`上移${labels[skill]}`}
                          disabled={index === 0}
                          onClick={() => {
                            const skillIds = [...job.skillIds];
                            [skillIds[index - 1], skillIds[index]] = [
                              skillIds[index],
                              skillIds[index - 1],
                            ];
                            c.patchJob(laneId, job.id, { skillIds });
                          }}
                        >
                          上移
                        </button>
                      </li>
                    ))}
                  </ol>
                )}
                <div className="ark-automation-options">
                  <button
                    type="button"
                    className="button"
                    role="switch"
                    aria-label={`启用${job.name}`}
                    aria-checked={job.enabled}
                    onClick={() =>
                      c.patchJob(laneId, job.id, { enabled: !job.enabled })
                    }
                  >
                    计划{job.enabled ? "已启用" : "已暂停"}
                  </button>
                  <button
                    type="button"
                    className="button"
                    role="switch"
                    aria-label={`${job.name}错过后当天补跑`}
                    aria-checked={job.catchUp}
                    onClick={() =>
                      c.patchJob(laneId, job.id, { catchUp: !job.catchUp })
                    }
                  >
                    错过后当天补跑{job.catchUp ? "：开" : "：关"}
                  </button>
                  <button
                    type="button"
                    className="text-button ark-automation-delete"
                    onClick={() => c.removeJob(laneId, job.id)}
                  >
                    删除计划
                  </button>
                </div>
              </fieldset>
            </details>
          </div>
        ))}
      </div>
      {c.dirty && (
        <p className="helper">自动计划有修改，请先在上方保存后运行。</p>
      )}
      <p className="helper">
        {isArk
          ? "刷关、招募和基建的详细参数使用此账号档案。"
          : "任务使用此账号保存的设置，地域鬼王次数按当天现场核对。"}
        <button type="button" className="text-button" onClick={onOpenSettings}>
          编辑账号参数
        </button>
      </p>
    </section>
  );
}
