import {
  resolveArknightsTaskOptions,
  infrastructureFacilities,
  droneUses,
  fiammettaTargets,
  type ArknightsTaskOptions,
} from "../../../../games/arknights/task-options";
import { useEffect, useState } from "react";
import type { ArknightsProfile } from "../../../../games/arknights/config";
import "./arknights-task-options.css";

const split = (value: string) => [
  ...new Set(
    value
      .split(/[;；\n]/)
      .map((item) => item.trim())
      .filter(Boolean),
  ),
];

/** Keep unfinished separators/newlines while the persisted value stays a typed list. */
function ListInput({
  value,
  onChange,
  disabled,
  multiline = false,
}: {
  value: string[];
  onChange(value: string[]): void;
  disabled: boolean;
  multiline?: boolean;
}) {
  const canonical = JSON.stringify(value);
  const [draft, setDraft] = useState(value.join(multiline ? "\n" : ";"));
  useEffect(() => {
    setDraft((previous) =>
      JSON.stringify(split(previous)) === canonical
        ? previous
        : value.join(multiline ? "\n" : ";"),
    );
  }, [canonical, multiline]);
  const props = {
    disabled,
    value: draft,
    onChange: (
      event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
    ) => {
      setDraft(event.target.value);
      onChange(split(event.target.value));
    },
  };
  return multiline ? (
    <textarea {...props} rows={3} aria-label="作战关卡队列" />
  ) : (
    <input {...props} />
  );
}

export default function ArknightsTaskOptionsPanel({
  profile,
  disabled,
  onChange,
}: {
  profile: ArknightsProfile;
  disabled: boolean;
  onChange(patch: Partial<ArknightsProfile>): void;
}) {
  const defaults = resolveArknightsTaskOptions();
  // Drafts may be temporarily incomplete (custom mode filename, empty material ID).
  const options = {
    fight: { ...defaults.fight, ...profile.taskOptions?.fight },
    recruit: { ...defaults.recruit, ...profile.taskOptions?.recruit },
    infrastructure: {
      ...defaults.infrastructure,
      ...profile.taskOptions?.infrastructure,
    },
    mall: { ...defaults.mall, ...profile.taskOptions?.mall },
  };
  function patch<K extends keyof ArknightsTaskOptions>(
    group: K,
    value: ArknightsTaskOptions[K],
  ) {
    onChange({
      taskOptions: {
        ...profile.taskOptions,
        [group]: { ...profile.taskOptions?.[group], ...value },
      },
    });
  }
  function numeric(
    label: string,
    value: number,
    change: (value: number) => void,
    min: number,
    max: number,
    step = 1,
  ) {
    return (
      <label>
        {label}
        <input
          type="number"
          disabled={disabled}
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(event) => change(Number(event.target.value))}
        />
      </label>
    );
  }
  function toggle(
    label: string,
    value: boolean,
    change: (value: boolean) => void,
  ) {
    return (
      <label className="ark-native-toggle" key={label}>
        <input
          type="checkbox"
          disabled={disabled}
          checked={value}
          onChange={(event) => change(event.target.checked)}
        />
        {label}
      </label>
    );
  }
  function tags(
    label: string,
    value: string[],
    change: (value: string[]) => void,
  ) {
    return (
      <label>
        {label}
        <ListInput disabled={disabled} value={value} onChange={change} />
        <small className="helper">多个条目用分号分隔</small>
      </label>
    );
  }
  return (
    <div className="ark-native-options">
      <details className="settings-details" open>
        <summary>作战队列与补给</summary>
        {toggle(
          "自动跟随开放活动，结束后用常驻关卡",
          options.fight.followActivity,
          (followActivity) => patch("fight", { followActivity }),
        )}
        <label>
          活动结束后的常驻关卡
          <input
            disabled={disabled}
            value={options.fight.fallbackStage}
            placeholder="LS-6、AP-5 或 1-7"
            onChange={(event) =>
              patch("fight", { fallbackStage: event.target.value })
            }
          />
        </label>
        <label>
          关卡队列（按顺序，每行一关）
          <ListInput
            multiline
            disabled={disabled}
            value={(options.fight.stages.length
              ? [profile.stage, ...options.fight.stages.slice(1)]
              : [profile.stage]
            ).filter(Boolean)}
            onChange={(stages) => {
              onChange({
                stage: stages[0] ?? "",
                taskOptions: {
                  ...profile.taskOptions,
                  fight: { ...profile.taskOptions?.fight, stages },
                },
              });
            }}
          />
        </label>
        <div className="ark-native-grid">
          {numeric(
            "每关最多作战次数",
            options.fight.times,
            (times) => patch("fight", { times }),
            1,
            2147483647,
          )}
          <label>
            自动代理倍率
            <select
              disabled={disabled}
              value={options.fight.series}
              onChange={(event) =>
                patch("fight", { series: Number(event.target.value) })
              }
            >
              <option value={0}>自动选择可用最大倍率</option>
              <option value={-1}>保留游戏当前倍率</option>
              {Array.from({ length: 10 }, (_, index) => index + 1).map(
                (count) => (
                  <option key={count} value={count}>
                    {count} 倍
                  </option>
                ),
              )}
            </select>
          </label>
          {numeric(
            "整个队列理智药上限",
            options.fight.medicine,
            (medicine) => patch("fight", { medicine }),
            0,
            999,
          )}
          {numeric(
            "整个队列源石上限",
            options.fight.stone,
            (stone) => patch("fight", { stone }),
            0,
            999,
          )}
          {numeric(
            "额外使用几天内到期的药（0 关闭）",
            options.fight.medicineExpireDays,
            (medicineExpireDays) => patch("fight", { medicineExpireDays }),
            0,
            365,
          )}
        </div>
        <p className="helper">
          2147483647
          表示持续代理到理智不足。各关共享补给预算与运行时限；前关结束后切换下一关。临期药遵循
          MAA 规则，可额外超过理智药上限。活动关卡需有对应导航资源并支持代理。
        </p>
        {toggle(
          "节省理智碎石模式（等待 1 点理智恢复）",
          options.fight.drGrandet,
          (drGrandet) => patch("fight", { drGrandet }),
        )}
        {toggle(
          "游戏崩溃时尝试重启当前客户端并继续作战",
          options.fight.restartOnCrash,
          (restartOnCrash) => patch("fight", { restartOnCrash }),
        )}
        <div className="ark-native-heading">
          <strong>新增掉落目标</strong>
          <button
            type="button"
            className="text-button"
            disabled={
              disabled ||
              Object.keys(options.fight.drops).length >= 20 ||
              Object.hasOwn(options.fight.drops, "")
            }
            onClick={() =>
              patch("fight", { drops: { ...options.fight.drops, "": 1 } })
            }
          >
            添加材料目标
          </button>
        </div>
        {Object.entries(options.fight.drops).map(([id, count], index) => (
          <div className="ark-native-drop" key={index}>
            <input
              aria-label={`掉落材料 ID ${index + 1}`}
              disabled={disabled}
              placeholder="材料 ID，例如 30011"
              value={id}
              onChange={(event) =>
                patch("fight", {
                  drops: Object.fromEntries(
                    Object.entries(options.fight.drops).map(([key, value]) => [
                      key === id ? event.target.value : key,
                      value,
                    ]),
                  ),
                })
              }
            />
            <input
              aria-label={`新增掉落数量 ${index + 1}`}
              disabled={disabled}
              type="number"
              min={1}
              max={1000000}
              value={count}
              onChange={(event) =>
                patch("fight", {
                  drops: {
                    ...options.fight.drops,
                    [id]: Number(event.target.value),
                  },
                })
              }
            />
            <button
              type="button"
              className="text-button"
              disabled={disabled}
              onClick={() =>
                patch("fight", {
                  drops: Object.fromEntries(
                    Object.entries(options.fight.drops).filter(
                      ([key]) => key !== id,
                    ),
                  ),
                })
              }
            >
              移除
            </button>
          </div>
        ))}
        <p className="helper">
          使用 MAA 材料
          ID；只计算本次队列新增掉落，任意一个目标达到即停止。不代表仓库库存总量。
        </p>
      </details>
      <details className="settings-details">
        <summary>公开招募参数</summary>
        <div className="ark-native-grid">
          {numeric(
            "公招次数",
            options.recruit.times,
            (times) => patch("recruit", { times }),
            0,
            999,
          )}
          {numeric(
            "三星招募保留许可数",
            options.recruit.reserveRecruitmentCount,
            (reserveRecruitmentCount) =>
              patch("recruit", { reserveRecruitmentCount }),
            0,
            999,
          )}
          {numeric(
            "三星招募时限（分钟）",
            options.recruit.recruitmentTime["3"],
            (minutes) =>
              patch("recruit", {
                recruitmentTime: {
                  ...options.recruit.recruitmentTime,
                  "3": minutes,
                },
              }),
            60,
            540,
          )}
          {numeric(
            "四星招募时限（分钟）",
            options.recruit.recruitmentTime["4"],
            (minutes) =>
              patch("recruit", {
                recruitmentTime: {
                  ...options.recruit.recruitmentTime,
                  "4": minutes,
                },
              }),
            60,
            540,
          )}
          <label>
            额外标签策略
            <select
              disabled={disabled}
              value={options.recruit.extraTagsMode}
              onChange={(event) =>
                patch("recruit", { extraTagsMode: Number(event.target.value) })
              }
            >
              <option value={0}>默认</option>
              <option value={1}>尽可能选 3 个标签</option>
              <option value={2}>尽可能选更多高星组合</option>
            </select>
          </label>
        </div>
        {toggle("刷新三星标签", options.recruit.refresh, (refresh) =>
          patch("recruit", { refresh }),
        )}
        <div className="ark-native-grid">
          {([3, 4] as const).map((star) => (
            <div key={star}>
              {toggle(
                `选择 ${star} 星标签`,
                options.recruit.select.includes(star),
                (selected) =>
                  patch("recruit", {
                    select: selected
                      ? [...options.recruit.select, star]
                      : options.recruit.select.filter(
                          (value) => value !== star,
                        ),
                  }),
              )}
              {toggle(
                `确认 ${star} 星招募`,
                options.recruit.confirm.includes(star),
                (selected) =>
                  patch("recruit", {
                    confirm: selected
                      ? [...options.recruit.confirm, star]
                      : options.recruit.confirm.filter(
                          (value) => value !== star,
                        ),
                  }),
              )}
            </div>
          ))}
        </div>
        {tags(
          "保留并跳过的标签（必须保留两种资深标签）",
          options.recruit.preserveTags,
          (preserveTags) => patch("recruit", { preserveTags }),
        )}
        {tags("三星首选标签", options.recruit.firstTags, (firstTags) =>
          patch("recruit", { firstTags }),
        )}
        <p className="helper">
          不使用加急许可。五星、六星资深标签保留给人工确认。
        </p>
      </details>
      <details className="settings-details">
        <summary>基建换班参数</summary>
        <div className="ark-native-grid">
          <label>
            换班模式
            <select
              disabled={disabled}
              value={options.infrastructure.mode}
              onChange={(event) =>
                patch("infrastructure", {
                  mode: Number(event.target.value) as 0 | 10000 | 20000,
                })
              }
            >
              <option value={20000}>进驻总览一键轮换</option>
              <option value={0}>自动计算效率与跨设施组合</option>
              <option value={10000}>自定义排班 JSON</option>
            </select>
          </label>
          <label>
            无人机用途
            <select
              disabled={disabled}
              value={options.infrastructure.drones}
              onChange={(event) =>
                patch("infrastructure", {
                  drones: event.target
                    .value as typeof options.infrastructure.drones,
                })
              }
            >
              {droneUses.map((use) => (
                <option key={use} value={use}>
                  {
                    {
                      _NotUse: "不使用",
                      Money: "龙门币",
                      SyntheticJade: "合成玉",
                      CombatRecord: "作战记录",
                      PureGold: "赤金",
                      OriginStone: "源石碎片",
                      Chip: "芯片",
                    }[use]
                  }
                </option>
              ))}
            </select>
          </label>
          {numeric(
            "自动换班心情阈值（0–1）",
            options.infrastructure.threshold,
            (threshold) => patch("infrastructure", { threshold }),
            0,
            1,
            0.05,
          )}
        </div>
        {options.infrastructure.mode === 10000 && (
          <div className="ark-native-grid">
            <label>
              排班 JSON 路径
              <input
                disabled={disabled}
                value={options.infrastructure.filename}
                onChange={(event) =>
                  patch("infrastructure", { filename: event.target.value })
                }
              />
            </label>
            {numeric(
              "方案序号（从 0 开始）",
              options.infrastructure.planIndex,
              (planIndex) => patch("infrastructure", { planIndex }),
              0,
              99,
            )}
          </div>
        )}
        <div className="ark-native-grid">
          {infrastructureFacilities.map((facility) =>
            toggle(
              {
                Mfg: "制造站",
                Trade: "贸易站",
                Power: "发电站",
                Control: "控制中枢",
                Reception: "会客室",
                Office: "办公室",
                Recycle: "回收站",
                Dorm: "宿舍",
                Processing: "加工站",
                Training: "训练室",
                AssistantChange: "更换副手",
              }[facility],
              options.infrastructure.facility.includes(facility),
              (enabled) =>
                patch("infrastructure", {
                  facility: enabled
                    ? [...options.infrastructure.facility, facility]
                    : options.infrastructure.facility.filter(
                        (item) => item !== facility,
                      ),
                }),
            ),
          )}
        </div>
        <div className="ark-native-grid">
          {(
            [
              ["replenish", "贸易站自动补充源石碎片"],
              ["dormNotStationed", "宿舍启用未进驻筛选"],
              ["dormTrust", "宿舍填充未满信赖干员"],
              ["fiammettaRecovery", "菲亚梅塔恢复心情"],
              ["usePinusSylvestris", "红松骑士团组合"],
              ["usePerceptionInformation", "感知信息组合"],
              ["useWorldlyPlight", "人间烟火组合"],
              ["useAbyssalHunter", "深海猎人组合"],
              ["receptionMessageBoard", "领取信息板信用"],
              ["receptionClueExchange", "开启线索交流"],
              ["receptionSendClue", "赠送线索"],
              ["continueTraining", "继续未完成专精训练"],
            ] as const
          ).map(([key, label]) =>
            toggle(label, options.infrastructure[key], (value) =>
              patch("infrastructure", { [key]: value }),
            ),
          )}
        </div>
        <div className="ark-native-grid">
          {fiammettaTargets.map((target) =>
            toggle(
              `恢复 ${target}`,
              options.infrastructure.fiammettaTargets.includes(target),
              (enabled) =>
                patch("infrastructure", {
                  fiammettaTargets: enabled
                    ? [...options.infrastructure.fiammettaTargets, target]
                    : options.infrastructure.fiammettaTargets.filter(
                        (item) => item !== target,
                      ),
                }),
            ),
          )}
        </div>
        <p className="helper">
          {options.infrastructure.mode === 20000 &&
            "预设换班在总览完成；默认进入会客室处理线索日常、进入贸易站使用无人机。关闭无人机仍保留会客室，不逐间重新排班。"}
          一键轮换模式会跳过部分设施；心情阈值、跨设施组合和菲亚梅塔仅在对应 MAA
          模式生效。
        </p>
      </details>
      <details className="settings-details">
        <summary>好友与信用商店参数</summary>
        {toggle("访问好友收集信用", options.mall.visitFriends, (visitFriends) =>
          patch("mall", { visitFriends }),
        )}
        {tags("优先购买", options.mall.buyFirst, (buyFirst) =>
          patch("mall", { buyFirst }),
        )}
        {tags("普通购买排除", options.mall.blacklist, (blacklist) =>
          patch("mall", { blacklist }),
        )}
        <div className="ark-native-grid">
          {toggle(
            "信用溢出时无视排除列表",
            options.mall.forceShoppingIfCreditFull,
            (forceShoppingIfCreditFull) =>
              patch("mall", { forceShoppingIfCreditFull }),
          )}
          {toggle(
            "普通购买只买折扣商品",
            options.mall.onlyBuyDiscount,
            (onlyBuyDiscount) => patch("mall", { onlyBuyDiscount }),
          )}
          {toggle(
            "普通购买在低于 300 信用时停止",
            options.mall.reserveMaxCredit,
            (reserveMaxCredit) => patch("mall", { reserveMaxCredit }),
          )}
          {toggle(
            "借助战完成 OF-1 以增加次日信用",
            options.mall.creditFight,
            (creditFight) => patch("mall", { creditFight }),
          )}
          {numeric(
            "信用作战编队（0 当前，1–4 指定）",
            options.mall.formationIndex,
            (formationIndex) => patch("mall", { formationIndex }),
            0,
            4,
          )}
        </div>
        <p className="helper">
          购买另受上方「信用商店自动购买」总开关控制。优先购买不受普通购买的折扣与余额限制。
        </p>
      </details>
    </div>
  );
}
