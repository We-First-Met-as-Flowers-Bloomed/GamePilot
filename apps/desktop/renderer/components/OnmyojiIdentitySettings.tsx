import { useEffect, useRef, useState } from "react";
import type { DesktopAPI, DeviceLane } from "../../../../packages/protocol";
import { validateOnmyojiIdentityBinding } from "../../../../packages/protocol/onmyoji-identity";

export default function OnmyojiIdentitySettings({
  lane,
  api,
  disabled,
  onChange,
}: {
  lane: DeviceLane;
  api?: DesktopAPI;
  disabled: boolean;
  onChange(identity: DeviceLane["onmyoji"]["identity"]): void;
}) {
  const [roleId, setRoleId] = useState(lane.onmyoji.identity?.roleId ?? "");
  const [serverName, setServerName] = useState(
    lane.onmyoji.identity?.serverName ?? "",
  );
  const [message, setMessage] = useState("");
  const [checking, setChecking] = useState(false);
  const scope = useRef(0);
  const draftMatches =
    roleId === lane.onmyoji.identity?.roleId &&
    serverName === lane.onmyoji.identity?.serverName;
  useEffect(() => {
    setRoleId(lane.onmyoji.identity?.roleId ?? "");
    setServerName(lane.onmyoji.identity?.serverName ?? "");
    ++scope.current;
    setChecking(false);
    setMessage((old) => (old.startsWith("请点击设备区域的保存") ? old : ""));
    return () => {
      ++scope.current;
    };
  }, [
    lane.id,
    lane.onmyoji.identity?.roleId,
    lane.onmyoji.identity?.serverName,
  ]);
  return (
    <details className="lane-identity">
      <summary>阴阳师角色核对 · 实验功能</summary>
      <p className="muted">
        填写角色资料页的角色 ID
        与服务器名。绑定后每日任务会暂停，直到角色锚点完成实机认证；自动恢复仍关闭。
      </p>
      <label>
        角色 ID
        <input
          value={roleId}
          disabled={disabled || checking}
          onChange={(e) => setRoleId(e.target.value)}
          autoComplete="off"
        />
      </label>
      <label>
        服务器名
        <input
          value={serverName}
          disabled={disabled || checking}
          onChange={(e) => setServerName(e.target.value)}
          autoComplete="off"
        />
      </label>
      <div className="lane-card-actions">
        <button
          className="button"
          disabled={disabled || checking}
          onClick={() => {
            try {
              onChange(validateOnmyojiIdentityBinding({ roleId, serverName }));
              setMessage("请点击设备区域的保存，再打开角色资料页进行核对。");
            } catch (e) {
              setMessage(e instanceof Error ? e.message : String(e));
            }
          }}
        >
          设置绑定
        </button>
        {lane.onmyoji.identity && (
          <button
            className="button"
            disabled={disabled || checking}
            onClick={() => {
              onChange(undefined);
              setMessage("");
            }}
          >
            移除绑定
          </button>
        )}
        <button
          className="button"
          disabled={
            disabled ||
            checking ||
            !api ||
            !lane.onmyoji.identity ||
            !draftMatches
          }
          onClick={async () => {
            if (!api) return;
            setChecking(true);
            setMessage("");
            const epoch = scope.current;
            try {
              const saved = (await api.deviceLanes()).lanes.find(
                (l) => l.id === lane.id,
              );
              if (JSON.stringify(saved) !== JSON.stringify(lane))
                throw Error("请先保存当前设备设置。");
              const result = await api.inspectOnmyojiIdentity(lane.id);
              if (scope.current !== epoch) return;
              setMessage(
                result.status === "mismatch"
                  ? "观察到的候选角色与绑定不同；锚点尚未实机认证。"
                  : result.reason === "anchors-not-certified"
                    ? "双帧候选一致；锚点尚未实机认证，身份仍未确认。"
                    : "当前页面无法确认角色。请打开游戏角色资料页后重试。",
              );
            } catch (e) {
              if (scope.current === epoch)
                setMessage(e instanceof Error ? e.message : String(e));
            } finally {
              if (scope.current === epoch) setChecking(false);
            }
          }}
        >
          {checking ? "正在核对…" : "核对当前角色页面"}
        </button>
      </div>
      {message && (
        <p role="status" className="muted">
          {message}
        </p>
      )}
    </details>
  );
}
