import { useEffect, useState } from "react";
import { Check, Plus, Trash2 } from "lucide-react";
import {
  defaultArknightsProfiles,
  validateArknightsProfiles,
  type ArknightsProfile,
  type ArknightsProfiles,
} from "../../../../games/arknights/config";
import type { DesktopController } from "../hooks/useDesktop";
import {
  arknightsAwardCapability,
  type AwardConfigKey,
} from "../../../../games/arknights/capabilities";

export function ArknightsRewardOption({
  configKey,
  label,
  value,
  disabled,
  onChange,
}: {
  configKey: AwardConfigKey;
  label: string;
  value: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  const capability = arknightsAwardCapability(configKey);
  return (
    <button
      type="button"
      className={`button ${value ? "checked" : ""}`}
      disabled={disabled || (!capability.supported && !value)}
      aria-pressed={value}
      title={capability.reason || undefined}
      onClick={() => onChange(!value)}
    >
      <span className="checkbox">{value && <Check size={13} />}</span>
      <span>
        {label}
        {!capability.supported && (
          <small className="muted">
            {value ? " · 当前不支持，请先关闭" : " · 当前不支持"}
          </small>
        )}
      </span>
    </button>
  );
}

export default function ArknightsSettings({
  desktop,
}: {
  desktop: DesktopController;
}) {
  const { api, active, busy } = desktop;
  const [settings, setSettings] = useState<ArknightsProfiles>(() =>
    structuredClone(defaultArknightsProfiles),
  );
  const [loaded, setLoaded] = useState(false);
  const working = busy === "arknights-save" || busy === "arknights-probe";
  const [message, setMessage] = useState("");
  const [engine, setEngine] = useState("尚未检测 MaaCore");
  const disabled = !api || !loaded || active || !!busy || working;
  const profile =
    settings.profiles.find((item) => item.id === settings.activeProfileId) ??
    settings.profiles[0];

  useEffect(() => {
    let mounted = true;
    api
      ?.arknights()
      .then((value) => {
        if (mounted) {
          setSettings(value);
          setLoaded(true);
        }
      })
      .catch((reason) => {
        if (mounted) setMessage(String(reason));
      });
    return () => {
      mounted = false;
    };
  }, [api]);

  function updateProfile(patch: Partial<ArknightsProfile>) {
    setSettings((previous) => ({
      ...previous,
      profiles: previous.profiles.map((item) =>
        item.id === previous.activeProfileId ? { ...item, ...patch } : item,
      ),
    }));
  }

  function addProfile() {
    const used = new Set(settings.profiles.map((item) => item.name));
    let name = "新账号";
    for (let index = 2; used.has(name); index += 1) name = `新账号 ${index}`;
    const next: ArknightsProfile = {
      ...defaultArknightsProfiles.profiles[0],
      id: crypto.randomUUID(),
      name,
    };
    setSettings((previous) => ({
      ...previous,
      activeProfileId: next.id,
      profiles: [...previous.profiles, next],
    }));
    setMessage("");
  }

  function removeProfile() {
    if (settings.profiles.length === 1) return;
    setSettings((previous) => {
      const profiles = previous.profiles.filter(
        (item) => item.id !== previous.activeProfileId,
      );
      return { ...previous, activeProfileId: profiles[0].id, profiles };
    });
    setMessage("账号档案已从编辑列表移除，保存后生效。");
  }

  async function save() {
    if (disabled || !api) return;
    await desktop.perform("arknights-save", async () => {
      setMessage("");
      try {
        setSettings(
          await desktop.saveArknights(validateArknightsProfiles(settings)),
        );
        setMessage("明日方舟账号档案已保存，将用于下次一键日常。");
      } catch (reason) {
        setMessage(reason instanceof Error ? reason.message : String(reason));
      }
    });
  }

  async function probe() {
    if (disabled || !api) return;
    await desktop.perform("arknights-probe", async () => {
      try {
        const result = await api.probeArknights();
        setEngine(`MaaCore ${result.version} 已加载`);
      } catch (reason) {
        setEngine(reason instanceof Error ? reason.message : String(reason));
      }
    });
  }

  return (
    <form
      className="surface game-settings-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="section-label">
        <h3>明日方舟 · 账号与任务</h3>
        <span className="badge">独立账号配置</span>
      </div>
      <p className="muted">
        每个档案独立保存服务器、关卡和邮件设置。每日计划使用设备页绑定的档案；工作台单设备任务使用这里的当前档案。
      </p>

      <fieldset className="settings-group">
        <legend>账号档案</legend>
        <div className="profile-toolbar">
          <label>
            当前账号档案
            <select
              disabled={disabled}
              value={settings.activeProfileId}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  activeProfileId: event.target.value,
                })
              }
            >
              {settings.profiles.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <div className="profile-actions">
            <button
              className="button"
              type="button"
              disabled={disabled || settings.profiles.length >= 20}
              onClick={addProfile}
            >
              <Plus size={14} /> 新建
            </button>
            <button
              className="button"
              type="button"
              disabled={disabled || settings.profiles.length === 1}
              onClick={removeProfile}
            >
              <Trash2 size={14} /> 删除
            </button>
          </div>
        </div>

        <label>
          档案名称
          <input
            disabled={disabled}
            value={profile.name}
            maxLength={40}
            placeholder="例如：B服主号"
            onChange={(event) => updateProfile({ name: event.target.value })}
          />
        </label>
        <label>
          MAA 账号匹配文本（可留空）
          <input
            disabled={disabled}
            value={profile.accountName}
            maxLength={100}
            placeholder="例如：博士昵称或账号备注"
            onChange={(event) =>
              updateProfile({ accountName: event.target.value })
            }
          />
        </label>
        <p className="muted">
          填写后，MAA
          会在已登录的游戏账号中按这段文字匹配并切换；留空则直接使用游戏当前登录的账号。这里不保存密码。
        </p>

        <label>
          核验 UID（可留空）
          <input
            disabled={disabled}
            value={profile.expectedUid ?? ""}
            inputMode="numeric"
            maxLength={12}
            placeholder="游戏主页左侧 ID 后的数字"
            onChange={(event) =>
              updateProfile({ expectedUid: event.target.value })
            }
          />
        </label>
        <p className="muted">
          与上方 MAA 启动匹配独立。填写后，登录完成会核对主页
          UID；不符或无法确认时停止后续任务。
          留空保持原有启动行为，身份显示未绑定。保存后用于新请求，旧请求保留原绑定；核对成功不会自动续跑。
        </p>
        <label id="arknights-client-label">游戏客户端</label>
        <div
          className="segmented"
          role="group"
          aria-labelledby="arknights-client-label"
        >
          {(
            [
              ["Official", "官服"],
              ["Bilibili", "B 服"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              disabled={disabled}
              aria-pressed={profile.clientType === value}
              className={profile.clientType === value ? "active" : ""}
              onClick={() => updateProfile({ clientType: value })}
            >
              {label}
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset className="settings-group">
        <legend>理智作战</legend>
        <label>
          代理作战关卡（可留空）
          <input
            disabled={disabled}
            value={profile.stage}
            maxLength={80}
            placeholder="例如 1-7"
            onChange={(event) => updateProfile({ stage: event.target.value })}
          />
        </label>
      </fieldset>
      <details className="settings-details">
        <summary>高级作业与运行时限</summary>
        <label>
          MAA 本地作业 JSON（高级任务，可留空）
          <input
            disabled={disabled}
            value={profile.copilotFile}
            maxLength={1024}
            placeholder="例如 D:\\MAA作业\\stage.json"
            onChange={(event) =>
              updateProfile({ copilotFile: event.target.value })
            }
          />
        </label>
        <label>
          作业循环次数
          <input
            disabled={disabled}
            type="number"
            min={1}
            max={99}
            value={profile.copilotLoopTimes}
            onChange={(event) =>
              updateProfile({ copilotLoopTimes: Number(event.target.value) })
            }
          />
        </label>
        <label>
          单次任务总时长上限（分钟）
          <input
            disabled={disabled}
            type="number"
            min={5}
            max={360}
            value={profile.maxRunMinutes}
            onChange={(event) =>
              updateProfile({ maxRunMinutes: Number(event.target.value) })
            }
          />
        </label>
      </details>
      <fieldset className="settings-group option-group">
        <legend>日常与奖励</legend>
        <button
          type="button"
          className={`button ${profile.recruit ? "checked" : ""}`}
          disabled={disabled}
          aria-pressed={profile.recruit}
          onClick={() => updateProfile({ recruit: !profile.recruit })}
        >
          <span className="checkbox">
            {profile.recruit && <Check size={13} />}
          </span>
          保守自动公招（不使用加急许可）
        </button>
        <button
          type="button"
          className={`button ${profile.mail ? "checked" : ""}`}
          disabled={disabled}
          aria-pressed={profile.mail}
          onClick={() => updateProfile({ mail: !profile.mail })}
        >
          <span className="checkbox">
            {profile.mail && <Check size={13} />}
          </span>
          领取邮件
        </button>
        {(
          [
            ["freeRecruit", "领取限定池每日免费单抽"],
            ["eventOrundum", "领取幸运墙合成玉"],
            ["eventMining", "领取限时开采许可奖励"],
            ["specialAccess", "领取特殊赠送月卡奖励"],
            ["signInEvent", "领取通用横版限时签到奖励"],
          ] as const
        ).map(([key, label]) => (
          <ArknightsRewardOption
            key={key}
            configKey={key}
            label={label}
            value={profile[key]}
            disabled={disabled}
            onChange={(value) => updateProfile({ [key]: value })}
          />
        ))}
        <button
          type="button"
          className={`button ${profile.creditShopping ? "checked" : ""}`}
          disabled={disabled}
          aria-pressed={profile.creditShopping}
          onClick={() =>
            updateProfile({ creditShopping: !profile.creditShopping })
          }
        >
          <span className="checkbox">
            {profile.creditShopping && <Check size={13} />}
          </span>
          信用商店自动购买（保守策略）
        </button>
      </fieldset>
      <p className="muted">
        {arknightsAwardCapability("signInEvent").reason}
        {profile.signInEvent && "当前档案保留了旧的开启值，请先关闭后保存。"}
      </p>
      <p className="muted">
        一键日常会在这个关卡按当前理智自动代理，理智不足时停止。理智药、过期理智药和源石补充均为
        0。信用购物随「好友与信用商店」步骤执行，早晚日常共用此账号开关。
        开启后优先购买招聘许可和龙门币（不限折扣、不受 300 信用阈值限制）；
        普通阶段只买折扣品，排除家具零件、加急许可与碳。若信用仍超过 300，
        继续购买信用商品，包括原价及原排除项，避免次日溢出清除。
        购买后双帧核对余额，不超过 300 为安全；售罄或余额无法确认时提示处理。
        基建使用进驻总览一键轮换。
      </p>
      <div className="arknights-actions">
        <button className="button primary" disabled={disabled} type="submit">
          {working ? "处理中…" : "保存明日方舟设置"}
        </button>
        <button
          className="button"
          disabled={disabled}
          type="button"
          onClick={() => void probe()}
        >
          检测 MaaCore
        </button>
      </div>
      <p className="muted" role="status">
        {engine}
      </p>
      {message && <p role="status">{message}</p>}
    </form>
  );
}
