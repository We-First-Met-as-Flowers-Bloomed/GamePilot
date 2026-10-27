import { useState } from "react";
import { Copy } from "lucide-react";
import type { DeviceLanes } from "../../../../packages/protocol";
import type { ChannelCopyInput } from "../../../../packages/protocol/channel";
import { channelGame } from "../../../../packages/protocol/account-channel";

export default function ChannelCopy({
  lanes,
  disabled,
  onCopy,
}: {
  lanes: DeviceLanes;
  disabled: boolean;
  onCopy(input: ChannelCopyInput): Promise<void>;
}) {
  const [sourceId, setSourceId] = useState("");
  const [targets, setTargets] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const source = lanes.lanes.find((l) => l.id === sourceId) ?? lanes.lanes[0];
  const gameId = source && channelGame(source);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    if (
      !source ||
      !gameId ||
      !/^\d{1,3}(?:\s*[,，]\s*\d{1,3})*$/.test(targets.trim())
    ) {
      setError(
        "请输入目标实例编号，例如 2,3。请先在 MuMu 多开器中创建这些实例。",
      );
      return;
    }
    const instances = targets
      .trim()
      .split(/\s*[,，]\s*/)
      .map(Number);
    if (new Set(instances).size !== instances.length) {
      setError("目标实例编号不能重复");
      return;
    }
    try {
      await onCopy({
        sourceLaneId: source.id,
        gameId,
        targets: instances.map((instance) => ({
          instance,
          name: `${name.trim() || source.name} · ${instance}`.slice(0, 40),
        })),
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }
  return (
    <details className="channel-copy">
      <summary>从已有渠道批量复制配置</summary>
      <p className="muted">
        选择已保存的配置作为模板。每个新渠道独立保存，初始暂停，绑定自己的账号后再启用。
      </p>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>
            源渠道
            <select
              value={source?.id ?? ""}
              disabled={disabled}
              onChange={(e) => setSourceId(e.target.value)}
            >
              {lanes.lanes.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            游戏（随源渠道复制）
            <output>
              {gameId === "arknights"
                ? "明日方舟"
                : gameId === "onmyoji"
                  ? "阴阳师"
                  : "请先选择单游戏渠道"}
            </output>
          </label>
          <label>
            目标 MuMu 实例编号
            <input
              value={targets}
              placeholder="例如 2,3"
              disabled={disabled}
              onChange={(e) => setTargets(e.target.value)}
            />
          </label>
          <label>
            新渠道名称前缀
            <input
              value={name}
              maxLength={32}
              placeholder={source?.name}
              disabled={disabled}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
        </div>
        {error && <p role="alert">{error}</p>}
        <button
          className="button"
          type="submit"
          disabled={disabled || !source || !gameId || !targets.trim()}
        >
          <Copy size={14} /> 创建独立配置副本
        </button>
      </form>
    </details>
  );
}
