import { ArrowDown, ArrowUp } from "lucide-react";
import { games, dailySkills } from "../../../../games/registry";
import { compileDailyPlan, defaultRoutine } from "../../../../games/routines";
import type {
  Routine,
  RoutineStep,
} from "../../../../packages/protocol/routine";

const days = [1, 2, 3, 4, 5, 6, 0];
const dayNames = ["日", "一", "二", "三", "四", "五", "六"];

export default function RoutineEditor({
  gameId,
  value,
  defaults,
  disabled,
  onChange,
}: {
  gameId: string;
  value?: Routine;
  defaults?: string[];
  disabled: boolean;
  onChange: (routine: Routine) => void;
}) {
  const game = games.find((g) => g.id === gameId)!;
  const saved = value ?? defaultRoutine(gameId, defaults);
  const entries: RoutineStep[] = saved.steps.filter(
    (step) =>
      !game.skills.find((skill) => skill.id === step.skillId)?.maintenanceOnly,
  );
  for (const id of dailySkills(gameId)) {
    if (!entries.some((s) => s.skillId === id))
      entries.push({ skillId: id, enabled: false });
  }
  const position = (id: string) =>
    game.skills.find((s) => s.id === id)?.position;
  entries.sort(
    (a, b) =>
      (position(a.skillId) === "first"
        ? -1
        : position(a.skillId) === "last"
          ? 1
          : 0) -
      (position(b.skillId) === "first"
        ? -1
        : position(b.skillId) === "last"
          ? 1
          : 0),
  );
  const steps = entries.map((s) =>
    position(s.skillId) === "first" ? { skillId: s.skillId, enabled: true } : s,
  );
  const save = (next: RoutineStep[]) => onChange({ version: 1, steps: next });
  const update = (id: string, patch: Partial<RoutineStep>) =>
    save(steps.map((s) => (s.skillId === id ? { ...s, ...patch } : s)));
  const move = (index: number, offset: number) => {
    const next = [...steps];
    [next[index], next[index + offset]] = [next[index + offset], next[index]];
    save(next);
  };
  const today = compileDailyPlan(gameId, value, defaults)
    .skillIds.map((id) => game.skills.find((s) => s.id === id)!.title)
    .join(" → ");
  return (
    <div className="routine-editor">
      <p className="routine-preview">今天执行：{today}</p>
      {game.skills.some((skill) => skill.maintenanceOnly) && (
        <p className="helper">
          好友寄养与满级式神更换独立于每日任务，可在自动化设置中启用每六小时检查。
        </p>
      )}
      <p className="helper">
        按列表顺序执行。上号固定在前，花合战固定在最后；日期按北京时间。修改后请保存计划。
      </p>
      <div className="routine-steps">
        {steps.map((step, index) => {
          const skill = game.skills.find((s) => s.id === step.skillId)!;
          const allowed = skill.weekdays ?? days;
          const selected = step.weekdays ?? allowed;
          return (
            <div key={step.skillId} className="routine-step">
              <div className="routine-step-heading">
                <label title={skill.description}>
                  <input
                    type="checkbox"
                    aria-label={`启用${skill.title}`}
                    checked={step.enabled}
                    disabled={disabled || skill.position === "first"}
                    onChange={(e) =>
                      update(step.skillId, { enabled: e.target.checked })
                    }
                  />
                  {skill.title}
                </label>
                {skill.position ? (
                  <span className="muted">
                    {skill.position === "first"
                      ? gameId === "arknights"
                        ? "上号 / UID 核验必需"
                        : "上号 / 登录核对必需"
                      : "最后领取"}
                  </span>
                ) : null}
              </div>
              {skill.position !== "first" && (
                <details>
                  <summary>执行日期与顺序</summary>
                  {!skill.position && (
                    <div className="routine-move">
                      <button
                        className="button"
                        aria-label={`上移${skill.title}`}
                        disabled={
                          disabled ||
                          index === 0 ||
                          !!position(steps[index - 1].skillId)
                        }
                        onClick={() => move(index, -1)}
                      >
                        <ArrowUp size={14} />
                      </button>
                      <button
                        className="button"
                        aria-label={`下移${skill.title}`}
                        disabled={
                          disabled ||
                          index === steps.length - 1 ||
                          !!position(steps[index + 1].skillId)
                        }
                        onClick={() => move(index, 1)}
                      >
                        <ArrowDown size={14} />
                      </button>
                    </div>
                  )}
                  <fieldset
                    className="routine-days"
                    disabled={disabled || !step.enabled}
                  >
                    <legend>
                      {skill.title}执行星期
                      {skill.id === "guild-kirin"
                        ? "（仅周一至四 06:00–23:00）"
                        : ""}
                    </legend>
                    {days.map((day) => (
                      <label key={day}>
                        <input
                          type="checkbox"
                          aria-label={`${skill.title}周${dayNames[day]}`}
                          checked={
                            selected.includes(day) && allowed.includes(day)
                          }
                          disabled={
                            !allowed.includes(day) ||
                            (selected.filter((d) => allowed.includes(d))
                              .length === 1 &&
                              selected.includes(day))
                          }
                          onChange={(e) =>
                            update(step.skillId, {
                              weekdays: e.target.checked
                                ? [
                                    ...selected.filter((d) =>
                                      allowed.includes(d),
                                    ),
                                    day,
                                  ]
                                : selected.filter(
                                    (d) => d !== day && allowed.includes(d),
                                  ),
                            })
                          }
                        />
                        {dayNames[day]}
                      </label>
                    ))}
                  </fieldset>
                </details>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
