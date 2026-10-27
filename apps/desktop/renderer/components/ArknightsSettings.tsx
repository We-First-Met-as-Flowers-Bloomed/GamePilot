import { useEffect, useRef, useState } from "react";
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
import ArknightsTaskOptionsPanel from "./ArknightsTaskOptions";
import ArknightsActivityStages from "./ArknightsActivityStages";
import ArknightsExtendedOptionsPanel from "./ArknightsExtendedOptions";
import ArknightsCopilotOptionsPanel from "./ArknightsCopilotOptions";

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
  profileId,
}: {
  desktop: DesktopController;
  profileId?: string;
}) {
  const { api, active, busy } = desktop;
  const [settings, setSettings] = useState<ArknightsProfiles>(() =>
    structuredClone(
      desktop.arknightsProfiles?.profiles.length
        ? desktop.arknightsProfiles
        : defaultArknightsProfiles,
    ),
  );
  const [loaded, setLoaded] = useState(
    !!desktop.arknightsProfiles?.profiles.length,
  );
  const working = busy === "arknights-save" || busy === "arknights-probe";
  const [message, setMessage] = useState("");
  const [engine, setEngine] = useState("尚未检测 MaaCore");
  const editRevision = useRef(0);
  const disabled = !api || !loaded || active || !!busy || working;
  const selectedProfileId = profileId ?? settings.activeProfileId;
  const profile =
    settings.profiles.find((item) => item.id === selectedProfileId) ??
    (profileId ? undefined : settings.profiles[0]);

  useEffect(() => {
    let mounted = true;
    const revisionAtRequest = editRevision.current;
    api
      ?.arknights()
      .then((value) => {
        if (mounted) {
          if (editRevision.current === revisionAtRequest) setSettings(value);
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
    editRevision.current++;
    setSettings((previous) => ({
      ...previous,
      profiles: previous.profiles.map((item) =>
        item.id === selectedProfileId ? { ...item, ...patch } : item,
      ),
    }));
  }

  function addProfile() {
    editRevision.current++;
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
    editRevision.current++;
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
        let next = settings;
        if (profileId) {
          const latest = await api.arknights();
          const changed = settings.profiles.find(
            (item) => item.id === profileId,
          );
          if (
            !changed ||
            !latest.profiles.some((item) => item.id === profileId)
          )
            throw Error("该渠道绑定的账号档案不存在，请重新绑定。");
          next = {
            ...latest,
            profiles: latest.profiles.map((item) =>
              item.id === profileId ? changed : item,
            ),
          };
        }
        const saved = await desktop.saveArknights(
          validateArknightsProfiles(next),
        );
        editRevision.current++;
        setSettings(saved);
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

  async function importMaa() {
    if (disabled || !api?.importMaaSettings || !profile) return;
    await desktop.perform("arknights-import", async () => {
      try {
        const result = await api.importMaaSettings!({ profileId: profile.id });
        if (!result) return;
        updateProfile(result.config);
        setMessage(
          `已导入到当前草稿，请检查后保存。${result.warnings.join(" ")}`,
        );
      } catch (reason) {
        setMessage(reason instanceof Error ? reason.message : String(reason));
      }
    });
  }

  if (!profile)
    return (
      <section className="surface" role="alert">
        该渠道绑定的账号档案不存在，请在账号与渠道页重新绑定。
      </section>
    );

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
        {profileId
          ? "正在编辑所选渠道绑定的账号档案，其他账号和手动设备工具的当前档案保持各自设置。"
          : "每个档案独立保存服务器、关卡和邮件设置。账号日常使用渠道绑定的档案；高级设备工具使用这里的当前档案。"}
      </p>

      <fieldset className="settings-group">
        <legend>账号档案</legend>
        {profileId ? (
          <p>当前渠道账号档案：{profile.name}</p>
        ) : (
          <div className="profile-toolbar">
            <label>
              当前账号档案
              <select
                disabled={disabled}
                value={settings.activeProfileId}
                onChange={(event) => {
                  editRevision.current++;
                  setSettings({
                    ...settings,
                    activeProfileId: event.target.value,
                  });
                }}
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
                disabled={disabled || settings.profiles.length >= 100}
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
        )}

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
      <ArknightsActivityStages
        api={api}
        profile={profile}
        disabled={disabled}
        onChange={updateProfile}
      />
      <ArknightsTaskOptionsPanel
        profile={profile}
        disabled={disabled}
        onChange={updateProfile}
      />
      <ArknightsExtendedOptionsPanel
        profile={profile}
        disabled={disabled}
        onChange={updateProfile}
      />
      <details className="settings-details">
        <summary>账号运行时限</summary>
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
      <ArknightsCopilotOptionsPanel
        profile={profile}
        disabled={disabled}
        onChange={updateProfile}
      />
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
      {!arknightsAwardCapability("signInEvent").supported && (
        <p className="muted">
          {arknightsAwardCapability("signInEvent").reason}
          {profile.signInEvent && "当前档案保留了旧的开启值，请先关闭后保存。"}
        </p>
      )}
      <p className="muted">
        一键日常使用此账号保存的任务参数。未设置补给时理智药、临期药与源石均关闭；
        信用购物随「好友与信用商店」步骤执行，早晚日常共用此账号开关。
        购买后仍会核对商店余额与场景；未确认时提示处理。
      </p>
      <div className="arknights-actions">
        <button className="button primary" disabled={disabled} type="submit">
          {working ? "处理中…" : "保存明日方舟设置"}
        </button>
        <button
          className="button"
          disabled={disabled || !api?.importMaaSettings}
          type="button"
          onClick={() => void importMaa()}
        >
          导入 MAA 设置
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
