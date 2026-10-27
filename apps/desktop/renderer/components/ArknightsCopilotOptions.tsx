import type { ArknightsProfile } from "../../../../games/arknights/config";
import {
  defaultArknightsCopilotOptions,
  type ArknightsCopilotOptions,
  type CopilotAdditionalOperator,
  type CopilotListEntry,
} from "../../../../games/arknights/copilot-options";
import "./arknights-copilot-options.css";

type CopilotProfile = ArknightsProfile & {
  copilotOptions?: ArknightsCopilotOptions;
};
type ProfilePatch = Partial<ArknightsProfile> & {
  copilotOptions?: ArknightsCopilotOptions;
};

export default function ArknightsCopilotOptionsPanel({
  profile,
  disabled,
  onChange,
}: {
  profile: CopilotProfile;
  disabled: boolean;
  onChange(patch: ProfilePatch): void;
}) {
  // Do not validate here: newly added paths and names must remain editable drafts.
  const value = {
    ...defaultArknightsCopilotOptions,
    loopTimes: profile.copilotLoopTimes,
    ...profile.copilotOptions,
  };
  const queueMode = value.list.length > 0;
  function patch(fields: ArknightsCopilotOptions, legacy: ProfilePatch = {}) {
    if (disabled) return;
    onChange({
      ...legacy,
      copilotOptions: { ...profile.copilotOptions, ...fields },
    });
  }
  function numeric(
    label: string,
    current: number,
    min: number,
    max: number,
    change: (value: number) => void,
    locked = disabled,
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
          disabled={locked}
          onChange={(event) => change(Number(event.target.value))}
        />
      </label>
    );
  }
  function text(
    label: string,
    current: string,
    change: (value: string) => void,
    locked = disabled,
    placeholder = "",
  ) {
    return (
      <label>
        {label}
        <input
          aria-label={label}
          value={current}
          disabled={locked}
          placeholder={placeholder}
          maxLength={label.includes("路径") ? 1024 : 100}
          onChange={(event) => change(event.target.value)}
        />
      </label>
    );
  }
  function checkbox(
    label: string,
    current: boolean,
    change: (value: boolean) => void,
    locked = disabled,
  ) {
    return (
      <label className="ark-copilot-checkbox">
        <input
          type="checkbox"
          aria-label={label}
          checked={current}
          disabled={locked}
          onChange={(event) => change(event.target.checked)}
        />
        {label}
      </label>
    );
  }
  function patchEntry(index: number, fields: Partial<CopilotListEntry>) {
    patch({
      list: value.list.map((entry, position) =>
        position === index ? { ...entry, ...fields } : entry,
      ),
    });
  }
  function patchOperator(
    index: number,
    fields: Partial<CopilotAdditionalOperator>,
  ) {
    patch({
      userAdditional: value.userAdditional.map((oper, position) =>
        position === index ? { ...oper, ...fields } : oper,
      ),
    });
  }
  const formationLocked = disabled || !value.formation;

  return (
    <details className="ark-copilot-options">
      <summary>普通战斗作业参数</summary>
      <p className="muted">
        内核已接入，待本机实机验证。此处仅保存参数；需在自动计划中选择“自动战斗作业”后执行。
      </p>
      <p className="muted">
        可在 App 作业库查询并下载作业，再填写本地 JSON 路径。仍受账号总时长上限{" "}
        {profile.maxRunMinutes} 分钟约束。
      </p>
      {text(
        "普通作业 JSON 路径",
        profile.copilotFile,
        (copilotFile) => {
          if (!disabled) onChange({ copilotFile });
        },
        disabled || queueMode,
        "D:\\Plans\\battle.json",
      )}
      <div className="ark-copilot-grid">
        {numeric(
          "普通作业循环次数",
          value.loopTimes,
          1,
          99,
          (loopTimes) => patch({ loopTimes }, { copilotLoopTimes: loopTimes }),
          disabled || value.stageNavigation || queueMode,
        )}
        {numeric(
          "普通作业最长运行分钟",
          value.maxRunMinutes,
          5,
          360,
          (maxRunMinutes) => patch({ maxRunMinutes }),
        )}
      </div>
      {checkbox(
        "普通作业关卡导航",
        value.stageNavigation,
        (stageNavigation) =>
          patch(
            {
              stageNavigation,
              ...(stageNavigation
                ? { loopTimes: 1 }
                : { stageName: "", isRaid: false }),
            },
            stageNavigation ? { copilotLoopTimes: 1 } : {},
          ),
        disabled || queueMode,
      )}
      <p className="muted">
        关闭导航时从游戏当前关卡执行单文件，可设置循环次数；开启导航时只执行一遍。作业文件中的地图信息仍用于战斗。
      </p>
      <div className="ark-copilot-grid">
        {text(
          "普通作业导航关卡",
          value.stageName,
          (stageName) => patch({ stageName }),
          disabled || !value.stageNavigation || queueMode,
          "留空从作业文件推导",
        )}
        {checkbox(
          "普通作业突袭模式",
          value.isRaid,
          (isRaid) => patch({ isRaid }),
          disabled || !value.stageNavigation || queueMode,
        )}
      </div>
      <details className="ark-copilot-details">
        <summary>有序作业队列 · {value.list.length} 项</summary>
        <p className="muted">
          队列按顺序导航并逐项执行一遍，循环次数不适用于队列。单文件路径保留，清空队列后恢复单文件设置。最多
          20 项。
        </p>
        {value.list.map((entry, index) => (
          <fieldset className="ark-copilot-entry" key={index}>
            <legend>普通作业 {index + 1}</legend>
            {text(
              `普通作业${index + 1} JSON 路径`,
              entry.filename,
              (filename) => patchEntry(index, { filename }),
            )}
            <div className="ark-copilot-grid">
              {text(
                `普通作业${index + 1}导航关卡`,
                entry.stageName ?? "",
                (stageName) => patchEntry(index, { stageName }),
                disabled,
                "留空从作业文件推导",
              )}
              {checkbox(
                `普通作业${index + 1}突袭模式`,
                entry.isRaid ?? false,
                (isRaid) => patchEntry(index, { isRaid }),
              )}
            </div>
            <div className="ark-copilot-actions">
              <button
                type="button"
                className="text-button"
                aria-label={`上移普通作业${index + 1}`}
                disabled={disabled || index === 0}
                onClick={() => {
                  if (!index || disabled) return;
                  const list = [...value.list];
                  [list[index - 1], list[index]] = [
                    list[index],
                    list[index - 1],
                  ];
                  patch({ list });
                }}
              >
                上移
              </button>
              <button
                type="button"
                className="text-button"
                aria-label={`移除普通作业${index + 1}`}
                disabled={disabled}
                onClick={() =>
                  patch({
                    list: value.list.filter(
                      (_, position) => position !== index,
                    ),
                  })
                }
              >
                移除
              </button>
            </div>
          </fieldset>
        ))}
        <button
          type="button"
          className="button"
          aria-label="添加普通作业"
          disabled={disabled || value.list.length >= 20}
          onClick={() => {
            if (disabled || value.list.length >= 20) return;
            patch(
              {
                list: [
                  ...value.list,
                  {
                    filename: profile.copilotFile,
                    ...(value.stageName ? { stageName: value.stageName } : {}),
                    isRaid: value.isRaid,
                  },
                ],
                loopTimes: 1,
              },
              { copilotLoopTimes: 1 },
            );
          }}
        >
          添加普通作业
        </button>
      </details>
      <details className="ark-copilot-details">
        <summary>自动编队与助战</summary>
        {checkbox("普通作业自动编队", value.formation, (formation) =>
          patch({ formation }),
        )}
        <div className="ark-copilot-grid">
          {numeric(
            "普通作业编队编号",
            value.formationIndex,
            0,
            4,
            (formationIndex) => patch({ formationIndex }),
            formationLocked,
          )}
          <label>
            普通作业助战策略
            <select
              aria-label="普通作业助战策略"
              value={value.supportUnitUsage}
              disabled={formationLocked}
              onChange={(event) =>
                patch({
                  supportUnitUsage: Number(event.target.value) as 0 | 1 | 2 | 3,
                })
              }
            >
              <option value={0}>不使用助战</option>
              <option value={1}>仅缺一名时补助战</option>
              <option value={2}>缺一名时补齐，否则使用指定干员</option>
              <option value={3}>缺一名时补齐，否则使用随机干员</option>
            </select>
          </label>
        </div>
        <p className="muted">
          编队编号 0 表示当前编队，1–4
          表示指定编队；以下设置仅在自动编队开启时生效。
        </p>
        {text(
          "普通作业指定助战干员",
          value.supportUnitName,
          (supportUnitName) => patch({ supportUnitName }),
          formationLocked || value.supportUnitUsage !== 2,
        )}
        {checkbox(
          "普通作业补充低信赖干员",
          value.addTrust,
          (addTrust) => patch({ addTrust }),
          formationLocked,
        )}
        {checkbox(
          "普通作业忽略干员属性要求",
          value.ignoreRequirements,
          (ignoreRequirements) => patch({ ignoreRequirements }),
          formationLocked,
        )}
        <p className="muted">
          未勾选“忽略干员属性要求”时，按作业要求检查干员属性。
        </p>
        <p className="muted">追加干员最多 12 名；技能 0 沿用游戏内当前选择。</p>
        {value.userAdditional.map((oper, index) => (
          <fieldset className="ark-copilot-entry" key={index}>
            <legend>追加干员 {index + 1}</legend>
            <div className="ark-copilot-grid">
              {text(
                `追加干员${index + 1}名称`,
                oper.name,
                (name) => patchOperator(index, { name }),
                formationLocked,
              )}
              <label>
                追加干员{index + 1}技能
                <select
                  aria-label={`追加干员${index + 1}技能`}
                  value={oper.skill}
                  disabled={formationLocked}
                  onChange={(event) =>
                    patchOperator(index, { skill: Number(event.target.value) })
                  }
                >
                  <option value={0}>沿用游戏内选择</option>
                  <option value={1}>技能 1</option>
                  <option value={2}>技能 2</option>
                  <option value={3}>技能 3</option>
                </select>
              </label>
            </div>
            <button
              type="button"
              className="text-button"
              aria-label={`移除追加干员${index + 1}`}
              disabled={formationLocked}
              onClick={() =>
                patch({
                  userAdditional: value.userAdditional.filter(
                    (_, position) => position !== index,
                  ),
                })
              }
            >
              移除
            </button>
          </fieldset>
        ))}
        <button
          type="button"
          className="button"
          aria-label="添加追加干员"
          disabled={formationLocked || value.userAdditional.length >= 12}
          onClick={() => {
            if (formationLocked || value.userAdditional.length >= 12) return;
            patch({
              userAdditional: [...value.userAdditional, { name: "", skill: 0 }],
            });
          }}
        >
          添加追加干员
        </button>
        {text(
          "普通作业干员识别数据 JSON 路径",
          value.operboxDataPath,
          (operboxDataPath) => patch({ operboxDataPath }),
          disabled,
          "可留空",
        )}
        <p className="muted">
          填写识别数据路径后，内核会加载该文件进行干员预检；留空则不加载。
        </p>
      </details>
      {checkbox(
        "普通作业使用理智药",
        value.useSanityPotion,
        (useSanityPotion) => patch({ useSanityPotion }),
      )}
      <p className="muted">
        默认不额外消耗理智药。仅在你明确勾选并保存后允许使用；普通作业原生接口不能限定药数量，刷关的药剂数量上限不适用于此项。
      </p>
    </details>
  );
}
