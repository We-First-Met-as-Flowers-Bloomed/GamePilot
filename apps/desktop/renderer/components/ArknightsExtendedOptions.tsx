import { useEffect, useState } from "react";
import type { ArknightsProfile } from "../../../../games/arknights/config";
import {
  resolveArknightsExtendedOptions,
  operatorRoles,
  roguelikeModesForTheme,
  roguelikeThemes,
  type ArknightsExtendedOptions,
  type ReclamationOptions,
  type OperatorProgressPlan,
  type RoguelikeMode,
  type RoguelikeTheme,
} from "../../../../games/arknights/extended-options";
import "./arknights-task-options.css";
import "./arknights-extended-options.css";

const modeLabels: Record<RoguelikeMode, string> = {
  0: "刷经验与奖励点数",
  1: "刷源石锭",
  4: "凹开局",
  5: "刷坍缩范式",
  6: "月度小队",
  7: "深入调查",
  10001: "快速通过第一层",
  20001: "刷常乐节点",
  30001: "刷襁褓动物",
  30003: "动物组合与目标开局",
};
const roleLabels: Record<(typeof operatorRoles)[number], string> = {
  Pioneer: "先锋",
  Warrior: "近卫",
  Tank: "重装",
  Sniper: "狙击",
  Caster: "术师",
  Medic: "医疗",
  Support: "辅助",
  Special: "特种",
};

const splitList = (value: string) => [
  ...new Set(
    value
      .split(/[;；\n]/)
      .map((part) => part.trim())
      .filter(Boolean),
  ),
];
function ThemeList({
  value,
  disabled,
  onChange,
}: {
  value: string[];
  disabled: boolean;
  onChange(value: string[]): void;
}) {
  const canonical = JSON.stringify(value);
  const [draft, setDraft] = useState(value.join("\n"));
  useEffect(() => {
    setDraft((previous) =>
      JSON.stringify(splitList(previous)) === canonical
        ? previous
        : value.join("\n"),
    );
  }, [canonical]);
  return (
    <textarea
      aria-label="主页主题候选项"
      value={draft}
      disabled={disabled}
      rows={3}
      onChange={(event) => {
        setDraft(event.target.value);
        onChange(splitList(event.target.value));
      }}
    />
  );
}

export default function ArknightsExtendedOptionsPanel({
  profile,
  disabled,
  onChange,
}: {
  profile: ArknightsProfile;
  disabled: boolean;
  onChange(patch: Partial<ArknightsProfile>): void;
}) {
  const defaults = resolveArknightsExtendedOptions();
  // Keep incomplete drafts editable; the profile save validates the complete configuration.
  const value = {
    roguelike: { ...defaults.roguelike, ...profile.extendedOptions?.roguelike },
    reclamation: {
      ...defaults.reclamation,
      ...profile.extendedOptions?.reclamation,
    },
    sssCopilot: {
      ...defaults.sssCopilot,
      ...profile.extendedOptions?.sssCopilot,
    },
    paradoxCopilot: {
      ...defaults.paradoxCopilot,
      ...profile.extendedOptions?.paradoxCopilot,
    },
    switchTheme: {
      ...defaults.switchTheme,
      ...profile.extendedOptions?.switchTheme,
    },
    depot: { ...defaults.depot, ...profile.extendedOptions?.depot },
    operatorBox: {
      ...defaults.operatorBox,
      ...profile.extendedOptions?.operatorBox,
    },
    videoRecognition: {
      ...defaults.videoRecognition,
      ...profile.extendedOptions?.videoRecognition,
    },
    customActivity: {
      ...defaults.customActivity,
      ...profile.extendedOptions?.customActivity,
    },
    operProgress: {
      ...defaults.operProgress,
      ...profile.extendedOptions?.operProgress,
    },
  };
  function patch<K extends keyof ArknightsExtendedOptions>(
    group: K,
    fields: ArknightsExtendedOptions[K],
  ) {
    onChange({
      extendedOptions: {
        ...profile.extendedOptions,
        [group]: { ...profile.extendedOptions?.[group], ...fields },
      },
    });
  }
  function numeric(
    label: string,
    current: number,
    change: (next: number) => void,
    min: number,
    max: number,
  ) {
    return (
      <label>
        {label}
        <input
          aria-label={label}
          type="number"
          step={1}
          min={min}
          max={max}
          value={current}
          disabled={disabled}
          onChange={(event) => change(Number(event.target.value))}
        />
      </label>
    );
  }
  function text(
    label: string,
    current: string,
    change: (next: string) => void,
    placeholder = "",
  ) {
    return (
      <label>
        {label}
        <input
          aria-label={label}
          value={current}
          disabled={disabled}
          placeholder={placeholder}
          maxLength={label.includes("路径") ? 1024 : 100}
          onChange={(event) => change(event.target.value)}
        />
      </label>
    );
  }
  function toggle(
    label: string,
    current: boolean,
    change: (next: boolean) => void,
  ) {
    return (
      <button
        type="button"
        className="button"
        role="switch"
        aria-label={label}
        aria-checked={current}
        disabled={disabled}
        onClick={() => change(!current)}
      >
        {label}：{current ? "开" : "关"}
      </button>
    );
  }
  function changeRogueMode(mode: RoguelikeMode, theme = value.roguelike.theme) {
    patch("roguelike", {
      theme,
      mode,
      ...(mode !== 4
        ? { startWithEliteTwo: false, onlyStartWithEliteTwo: false }
        : {}),
      ...(theme !== "Sami" || mode !== 4 ? { startFoldartalList: [] } : {}),
    });
  }
  function changeRogueTheme(theme: RoguelikeTheme) {
    const modes = roguelikeModesForTheme(theme);
    changeRogueMode(
      modes.includes(value.roguelike.mode) ? value.roguelike.mode : modes[0],
      theme,
    );
  }
  function patchPlan(index: number, fields: Partial<OperatorProgressPlan>) {
    patch("operProgress", {
      plans: value.operProgress.plans.map((plan, position) =>
        position === index ? { ...plan, ...fields } : plan,
      ),
    });
  }
  const reclamationThemes: ReclamationOptions["theme"][] = [
    "Tales",
    "RelaunchAnchor",
  ];
  const reclamationModes: ReclamationOptions["mode"][] =
    value.reclamation.theme === "Tales" ? [0, 1] : [16, 32, 48];

  return (
    <div className="ark-native-options ark-extended-options">
      <details className="settings-details">
        <summary>更多 MAA 能力参数</summary>
        <p className="muted">
          内核已接入，待本机实机验证。此处仅保存参数；需要在自动计划中主动选择对应高级任务后执行。
        </p>
        <p className="muted">
          各任务同时受账号总时长上限 {profile.maxRunMinutes}{" "}
          分钟约束，到达较小的上限后停止。
        </p>
        <details className="settings-details">
          <summary>活动小游戏</summary>
          <p className="muted">请在“活动关卡与小游戏”中同步并选择官方任务。</p>
          <p className="ark-activity-selection">
            当前选择：<span>{value.customActivity.route || "尚未选择"}</span>
          </p>
          {numeric(
            "小游戏最长运行分钟",
            value.customActivity.maxRunMinutes,
            (maxRunMinutes) => patch("customActivity", { maxRunMinutes }),
            5,
            360,
          )}
          {!!value.customActivity.route && (
            <button
              type="button"
              className="text-button"
              disabled={disabled}
              onClick={() => patch("customActivity", { route: "" })}
            >
              清除小游戏选择
            </button>
          )}
        </details>
        <details className="settings-details">
          <summary>干员养成</summary>
          <p className="muted">
            按目标消耗游戏内已有材料，没有逐物品数量上限。请核对精英化、技能等级与专精目标后授权；关闭授权时不会执行养成。
          </p>
          {toggle(
            "同意按目标消耗已有材料",
            value.operProgress.allowMaterialConsumption,
            (allowMaterialConsumption) =>
              patch("operProgress", { allowMaterialConsumption }),
          )}
          <p className="muted">
            最多 20
            个干员。精英化、技能等级可留空以跳过；每个干员至少设置一项目标，专精
            0 表示不升级该技能。
          </p>
          {value.operProgress.plans.map((plan, index) => (
            <fieldset className="ark-operator-target" key={index}>
              <legend>养成目标 {index + 1}</legend>
              <div className="ark-native-grid">
                {text(`目标${index + 1}干员名称`, plan.name, (name) =>
                  patchPlan(index, { name }),
                )}
                <label>
                  目标{index + 1}职业
                  <select
                    aria-label={`目标${index + 1}职业`}
                    value={plan.role ?? ""}
                    disabled={disabled}
                    onChange={(event) =>
                      patchPlan(index, {
                        role:
                          event.target.value === ""
                            ? undefined
                            : (event.target
                                .value as OperatorProgressPlan["role"]),
                      })
                    }
                  >
                    <option value="">自动匹配</option>
                    {operatorRoles.map((role) => (
                      <option key={role} value={role}>
                        {roleLabels[role]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  目标{index + 1}精英化
                  <input
                    aria-label={`目标${index + 1}精英化`}
                    type="number"
                    step={1}
                    min={1}
                    max={2}
                    value={plan.elite ?? ""}
                    placeholder="留空跳过"
                    disabled={disabled}
                    onChange={(event) =>
                      patchPlan(index, {
                        elite:
                          event.target.value === ""
                            ? undefined
                            : (Number(event.target.value) as 1 | 2),
                      })
                    }
                  />
                </label>
                <label>
                  目标{index + 1}技能等级
                  <input
                    aria-label={`目标${index + 1}技能等级`}
                    type="number"
                    step={1}
                    min={2}
                    max={7}
                    value={plan.skillLevel ?? ""}
                    placeholder="留空跳过"
                    disabled={disabled}
                    onChange={(event) =>
                      patchPlan(index, {
                        skillLevel:
                          event.target.value === ""
                            ? undefined
                            : Number(event.target.value),
                      })
                    }
                  />
                </label>
              </div>
              <div className="ark-operator-mastery">
                {([0, 1, 2] as const).map((skill) => (
                  <div key={skill}>
                    {numeric(
                      `目标${index + 1}技能${skill + 1}专精`,
                      plan.skillMastery?.[skill] ?? 0,
                      (level) => {
                        const skillMastery: [number, number, number] = [
                          ...(plan.skillMastery ?? [0, 0, 0]),
                        ];
                        skillMastery[skill] = level;
                        patchPlan(index, { skillMastery });
                      },
                      0,
                      3,
                    )}
                  </div>
                ))}
              </div>
              <button
                type="button"
                className="text-button"
                aria-label={`移除养成目标${index + 1}`}
                disabled={disabled}
                onClick={() =>
                  patch("operProgress", {
                    plans: value.operProgress.plans.filter(
                      (_, position) => position !== index,
                    ),
                  })
                }
              >
                移除目标
              </button>
            </fieldset>
          ))}
          <button
            type="button"
            className="button"
            aria-label="添加养成目标"
            disabled={disabled || value.operProgress.plans.length >= 20}
            onClick={() => {
              if (disabled || value.operProgress.plans.length >= 20) return;
              patch("operProgress", {
                plans: [...value.operProgress.plans, { name: "", elite: 1 }],
              });
            }}
          >
            添加养成目标
          </button>
          {numeric(
            "养成最长运行分钟",
            value.operProgress.maxRunMinutes,
            (maxRunMinutes) => patch("operProgress", { maxRunMinutes }),
            5,
            360,
          )}
        </details>
        <details className="settings-details">
          <summary>集成战略（肉鸽）</summary>
          <div
            className="ark-extended-choices"
            role="group"
            aria-label="肉鸽主题"
          >
            {roguelikeThemes.map((theme) => (
              <button
                key={theme}
                type="button"
                className="button"
                aria-label={`肉鸽主题 ${theme}`}
                aria-pressed={value.roguelike.theme === theme}
                disabled={disabled}
                onClick={() => changeRogueTheme(theme)}
              >
                {theme}
              </button>
            ))}
          </div>
          <div
            className="ark-extended-choices"
            role="group"
            aria-label="肉鸽模式"
          >
            {roguelikeModesForTheme(value.roguelike.theme).map((mode) => (
              <button
                key={mode}
                type="button"
                className="button"
                aria-label={`肉鸽模式 ${mode}`}
                aria-pressed={value.roguelike.mode === mode}
                disabled={disabled}
                onClick={() => changeRogueMode(mode)}
              >
                {modeLabels[mode]}（{mode}）
              </button>
            ))}
          </div>
          <div className="ark-native-grid">
            {numeric(
              "肉鸽启动次数",
              value.roguelike.startsCount,
              (startsCount) => patch("roguelike", { startsCount }),
              1,
              999,
            )}
            {numeric(
              "肉鸽投资上限",
              value.roguelike.investmentsCount,
              (investmentsCount) => patch("roguelike", { investmentsCount }),
              0,
              99999,
            )}
            {numeric(
              "肉鸽难度",
              value.roguelike.difficulty,
              (difficulty) => patch("roguelike", { difficulty }),
              -1,
              99,
            )}
            {numeric(
              "肉鸽最长运行分钟",
              value.roguelike.maxRunMinutes,
              (maxRunMinutes) => patch("roguelike", { maxRunMinutes }),
              5,
              360,
            )}
            {text("肉鸽分队", value.roguelike.squad, (squad) =>
              patch("roguelike", {
                squad,
                ...(squad !== "生活至上分队" ? { startFoldartalList: [] } : {}),
              }),
            )}
            {text("肉鸽职业组", value.roguelike.roles, (roles) =>
              patch("roguelike", { roles }),
            )}
          </div>
          <p className="muted">
            难度 -1 沿用游戏内选择；启动次数与运行时长均有限制。
          </p>
          <div className="ark-extended-choices">
            {toggle(
              "肉鸽投资",
              value.roguelike.investmentEnabled,
              (investmentEnabled) => patch("roguelike", { investmentEnabled }),
            )}
            {toggle(
              "投资满额后停止",
              value.roguelike.stopWhenInvestmentFull,
              (stopWhenInvestmentFull) =>
                patch("roguelike", { stopWhenInvestmentFull }),
            )}
            {toggle(
              "最终首领前停止",
              value.roguelike.stopAtFinalBoss,
              (stopAtFinalBoss) => patch("roguelike", { stopAtFinalBoss }),
            )}
          </div>
          {value.roguelike.theme === "BlackFlow" &&
            value.roguelike.mode === 30003 && (
              <div className="ark-native-grid">
                {numeric(
                  "BlackFlow 开局奖励位掩码",
                  value.roguelike.blackflowStartRewards,
                  (blackflowStartRewards) =>
                    patch("roguelike", { blackflowStartRewards }),
                  0,
                  4095,
                )}
              </div>
            )}
          {value.roguelike.theme === "JieGarden" &&
            value.roguelike.mode === 20001 && (
              <div
                className="ark-extended-choices"
                role="group"
                aria-label="寻找玩乐目标"
              >
                {([1, 2, 3] as const).map((findPlayTimeTarget) => (
                  <button
                    key={findPlayTimeTarget}
                    type="button"
                    className="button"
                    disabled={disabled}
                    aria-pressed={
                      value.roguelike.findPlayTimeTarget === findPlayTimeTarget
                    }
                    onClick={() => patch("roguelike", { findPlayTimeTarget })}
                  >
                    目标 {findPlayTimeTarget}
                  </button>
                ))}
              </div>
            )}
        </details>
        <details className="settings-details">
          <summary>生息演算</summary>
          <div
            className="ark-extended-choices"
            role="group"
            aria-label="生息演算主题"
          >
            {reclamationThemes.map((theme) => (
              <button
                key={theme}
                type="button"
                className="button"
                aria-pressed={value.reclamation.theme === theme}
                disabled={disabled}
                onClick={() =>
                  patch("reclamation", {
                    theme,
                    mode: theme === "Tales" ? 0 : 16,
                  })
                }
              >
                {theme}
              </button>
            ))}
          </div>
          <div
            className="ark-extended-choices"
            role="group"
            aria-label="生息演算模式"
          >
            {reclamationModes.map((mode) => (
              <button
                key={mode}
                type="button"
                className="button"
                aria-pressed={value.reclamation.mode === mode}
                disabled={disabled}
                onClick={() => patch("reclamation", { mode })}
              >
                模式 {mode}
              </button>
            ))}
          </div>
          <div className="ark-native-grid">
            {numeric(
              "生息制作批数",
              value.reclamation.numCraftBatches,
              (numCraftBatches) => patch("reclamation", { numCraftBatches }),
              1,
              99,
            )}
            {numeric(
              "生息最长运行分钟",
              value.reclamation.maxRunMinutes,
              (maxRunMinutes) => patch("reclamation", { maxRunMinutes }),
              5,
              360,
            )}
          </div>
          {toggle("清空商店", value.reclamation.clearStore, (clearStore) =>
            patch("reclamation", { clearStore }),
          )}
        </details>
        <details className="settings-details">
          <summary>保全与悖论模拟作业</summary>
          {text(
            "保全作业 JSON 路径",
            value.sssCopilot.filename,
            (filename) => patch("sssCopilot", { filename }),
            "D:\\Plans\\sss.json",
          )}
          <div className="ark-native-grid">
            {numeric(
              "保全循环次数",
              value.sssCopilot.loopTimes,
              (loopTimes) => patch("sssCopilot", { loopTimes }),
              1,
              99,
            )}
            {numeric(
              "保全最长运行分钟",
              value.sssCopilot.maxRunMinutes,
              (maxRunMinutes) => patch("sssCopilot", { maxRunMinutes }),
              5,
              360,
            )}
          </div>
          {text(
            "悖论模拟作业 JSON 路径",
            value.paradoxCopilot.filename,
            (filename) => patch("paradoxCopilot", { filename, list: [] }),
            "D:\\Plans\\paradox.json",
          )}
          {!!value.paradoxCopilot.list.length && (
            <p className="muted">
              已配置 {value.paradoxCopilot.list.length}{" "}
              项批量悖论作业。填写单文件路径会替换批量清单。
            </p>
          )}
          {numeric(
            "悖论模拟最长运行分钟",
            value.paradoxCopilot.maxRunMinutes,
            (maxRunMinutes) => patch("paradoxCopilot", { maxRunMinutes }),
            5,
            360,
          )}
          <p className="muted">
            使用本地作业文件。保全作业需要先准备游戏内编队。
          </p>
        </details>
        <details className="settings-details">
          <summary>主题候选、识别与本地录像</summary>
          <label>
            主页主题候选项
            <ThemeList
              key={profile.id}
              value={value.switchTheme.themes}
              disabled={disabled}
              onChange={(themes) => patch("switchTheme", { themes })}
            />
          </label>
          <p className="muted">每行一个主题名称，也可用分号分隔。</p>
          <div className="ark-native-grid">
            {numeric(
              "仓库识别最长运行分钟",
              value.depot.maxRunMinutes,
              (maxRunMinutes) => patch("depot", { maxRunMinutes }),
              5,
              360,
            )}
            {numeric(
              "干员识别最长运行分钟",
              value.operatorBox.maxRunMinutes,
              (maxRunMinutes) => patch("operatorBox", { maxRunMinutes }),
              5,
              360,
            )}
          </div>
          {text(
            "本地录像文件路径",
            value.videoRecognition.filename,
            (filename) => patch("videoRecognition", { filename }),
            "D:\\Recordings\\battle.mp4",
          )}
          {numeric(
            "录像识别最长运行分钟",
            value.videoRecognition.maxRunMinutes,
            (maxRunMinutes) => patch("videoRecognition", { maxRunMinutes }),
            5,
            360,
          )}
        </details>
      </details>
    </div>
  );
}
