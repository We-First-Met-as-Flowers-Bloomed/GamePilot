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
    serverName === (lane.onmyoji.identity?.serverName ?? "");
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
    lane.managerPath,
    lane.instance,
    lane.deviceInstances?.onmyoji,
    lane.identityRequired,
    lane.onmyoji.enabled,
    lane.onmyoji.identity?.roleId,
    lane.onmyoji.identity?.serverName,
  ]);
  return (
    <details className="lane-identity">
      <summary>阴阳师角色核对</summary>
      <p className="muted">
        自动打开庭院左上角头像，核对当前“编号”并返回庭院。
        不使用“曾用编号”；区服仅作备注。UID 不符或无法确认时停止任务。
      </p>
      <label>
        UID（当前编号）
        <input
          value={roleId}
          disabled={disabled || checking}
          onChange={(e) => setRoleId(e.target.value)}
          autoComplete="off"
          inputMode="numeric"
        />
      </label>
      <label>
        区服备注（选填）
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
              onChange(
                validateOnmyojiIdentityBinding({
                  roleId,
                  ...(serverName ? { serverName } : {}),
                }),
              );
              setMessage("请点击设备区域的保存，再核对当前角色。");
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
                result.status === "matched" && result.certified
                  ? "UID 双帧一致，已返回庭院。"
                  : result.status === "mismatch"
                    ? "当前 UID 与绑定账号不同，已停止后续任务。"
                    : result.reason === "anchors-not-certified"
                      ? "双帧候选一致；锚点尚未实机认证，身份仍未确认。"
                      : "当前无法确认 UID 或返回庭院。请确认游戏已在庭院，再重试。",
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
