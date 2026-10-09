/** Host-owned deadlines: native waits cannot safely be cancelled with Promise.race. */
export const nativeWaitLimits = {
  screencap: { timeoutMs: 15_000, label: "游戏截图" },
  connection: { timeoutMs: 30_000, label: "设备连接" },
  discovery: { timeoutMs: 30_000, label: "设备发现" },
  resource: { timeoutMs: 30_000, label: "识别资源加载" },
  recognition: { timeoutMs: 30_000, label: "画面识别" },
  input: { timeoutMs: 30_000, label: "设备操作" },
} as const;
export type NativeOperation = keyof typeof nativeWaitLimits;
export interface NativeWait {
  id: string;
  operation: NativeOperation;
  phase: "begin" | "end";
}
export function validNativeWait(value: unknown): value is NativeWait {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    Object.keys(v).every((key) => ["id", "operation", "phase"].includes(key)) &&
    typeof v.id === "string" &&
    /^[a-zA-Z0-9-]{1,80}$/.test(v.id) &&
    typeof v.operation === "string" &&
    Object.hasOwn(nativeWaitLimits, v.operation) &&
    (v.phase === "begin" || v.phase === "end")
  );
}
