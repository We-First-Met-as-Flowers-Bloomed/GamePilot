import { useEffect, useState } from "react";
import type {
  DesktopAPI,
  AutomationSettings as Config,
  MuMuInstallation,
} from "../../../../packages/protocol";
export default function AutomationSettings({
  api,
}: {
  api: DesktopAPI | undefined;
}) {
  const [config, setConfig] = useState<Config>();
  const [candidates, setCandidates] = useState<MuMuInstallation[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    api
      ?.automation()
      .then(setConfig)
      .catch((e) => setMessage(String(e)));
  }, [api]);
  async function detect() {
    if (!api || !config) return;
    setBusy(true);
    setMessage("");
    try {
      const found = await api.detectMuMu();
      setCandidates(found);
      if (found.length === 1)
        setConfig({ ...config, managerPath: found[0].managerPath });
      setMessage(
        found.length
          ? `找到 ${found.length} 个安装位置，保存后生效`
          : "未找到 MuMu，可手动填写管理器完整路径",
      );
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!api || !config) return;
    setBusy(true);
    setMessage("");
    try {
      setConfig(await api.saveAutomation(config));
      setMessage("已保存，定时设置立即生效；打开后执行开关在下次启动时生效");
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="surface">
      <h3>每日计划 · 启动与自动化</h3>
      <p className="muted">
        第一轮使用「每日计划」中启用的设备和游戏；第二轮只运行其中已启用的明日方舟账号。两轮分别记录结果，账号配置保持一致。
      </p>
      {config && (
        <>
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={detect}
          >
            检测 MuMu 安装位置
          </button>
          {candidates.length > 1 && (
            <label>
              选择安装位置
              <select
                value={config.managerPath}
                onChange={(e) =>
                  setConfig({ ...config, managerPath: e.target.value })
                }
              >
                <option value="">请选择</option>
                {candidates.map((c) => (
                  <option key={c.managerPath}>{c.managerPath}</option>
                ))}
              </select>
            </label>
          )}
          <label>
            MuMuManager.exe 路径
            <input
              value={config.managerPath}
              onChange={(e) =>
                setConfig({ ...config, managerPath: e.target.value })
              }
              placeholder="检测或填写完整路径"
            />
          </label>
          <label>
            单设备工具的 MuMu 实例编号
            <input
              type="number"
              min="0"
              max="999"
              value={config.instance}
              onChange={(e) =>
                setConfig({ ...config, instance: Number(e.target.value) })
              }
            />
          </label>
          <p className="muted">
            此编号用于单设备调试；每日计划使用设备页中各通道的实例编号。
          </p>
          {(
            [
              ["openAtLogin", "登录 Windows 后启动 GamePilot"],
              ["launchEmulator", "执行任务前自动启动并连接 MuMu"],
              ["runOnLaunch", "打开 GamePilot 后自动执行每日任务"],
              ["scheduleEnabled", "每天定时执行，错过后当天补跑"],
              [
                "secondScheduleEnabled",
                "增加第二轮日常（仅明日方舟，需启用每天定时执行）",
              ],
              [
                "fosterScheduleEnabled",
                "每 6 小时检查寄养并更换满级式神（结果未确认时暂停；先核对并处置原任务，再重新启用以检查恢复条件）",
              ],
              ["closeToTray", "关闭窗口时收进托盘，继续等待定时任务"],
              ["notifyResults", "任务完成或异常时显示本地通知"],
              [
                "closeEmulatorAfterSuccess",
                "成功后关闭本次由 GamePilot 启动的 MuMu",
              ],
            ] as const
          ).map(([key, label]) => (
            <label
              key={key}
              style={{ display: "flex", alignItems: "center", gap: 12 }}
            >
              <input
                style={{ width: 16, margin: 0 }}
                type="checkbox"
                checked={config[key]}
                onChange={(e) =>
                  setConfig({ ...config, [key]: e.target.checked })
                }
              />
              {label}
            </label>
          ))}
          <label>
            第一轮执行时间（电脑本地时间）
            <input
              type="time"
              value={config.scheduleTime}
              onChange={(e) =>
                setConfig({ ...config, scheduleTime: e.target.value })
              }
            />
          </label>
          {config.secondScheduleEnabled && (
            <label>
              第二轮执行时间（仅明日方舟，电脑本地时间）
              <input
                type="time"
                value={config.secondScheduleTime}
                onChange={(e) =>
                  setConfig({ ...config, secondScheduleTime: e.target.value })
                }
              />
            </label>
          )}
          <p className="muted">
            同一游戏日每轮最多自动尝试一次，早晚互不阻挡。错过多轮只补最近已到时间的一轮；设备忙时等待空闲。若希望严格到点再跑，请关闭「打开后自动执行」。结界维护按最近成功时间每
            6
            小时独立运行，错过后在应用恢复时补做。失败或取消后请检查现场；既有模拟器会保留。托盘菜单中的「退出」会结束常驻，关机或睡眠期间不执行。
          </p>
          <button
            className="button"
            type="button"
            disabled={busy}
            onClick={async () => {
              if (!api) return;
              setBusy(true);
              try {
                setMessage(await api.testNotification());
              } catch (e) {
                setMessage(String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            发送测试通知
          </button>
          <p className="muted">
            具体任务沿用每日计划和各账号设置；第一轮按明日方舟 →
            阴阳师顺序运行。需要先登录账号并准备阵容。
          </p>
          <button
            type="button"
            className="button primary"
            disabled={busy}
            onClick={save}
          >
            {busy ? "处理中…" : "保存启动设置"}
          </button>
          <button
            type="button"
            className="button"
            style={{ marginLeft: 8 }}
            onClick={() => {
              void api?.quit();
            }}
          >
            退出 GamePilot
          </button>
        </>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
