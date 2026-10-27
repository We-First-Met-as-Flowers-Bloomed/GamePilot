import { asRecord, recordWithKeys } from "../../packages/protocol/struct";
export type RecognitionTask = "Depot" | "OperBox" | "Recruit";
export interface RecognitionOutput {
  version: 1;
  taskType: RecognitionTask;
  taskId: number;
  events: { name: string; details: Record<string, unknown> }[];
  truncated: boolean;
}
const allowed = (type: string): type is RecognitionTask =>
  ["Depot", "OperBox", "Recruit"].includes(type);
function safe(value: unknown, depth = 0): unknown {
  if (depth > 8) throw Error("识别输出过深");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw Error("识别数值无效");
    return value;
  }
  if (typeof value === "string") {
    if (value.length > 4096 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value))
      throw Error("识别文本过长");
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 2000) throw Error("识别列表过长");
    return value.map((v) => safe(v, depth + 1));
  }
  const o = asRecord(value);
  if (!o || Object.keys(o).length > 2000) throw Error("识别结构无效");
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, item] of Object.entries(o)) {
    if (
      key.length > 128 ||
      /^(?:__proto__|constructor|prototype)$/i.test(key) ||
      /(?:password|api.?key|token|secret|image|screenshot)/i.test(key)
    )
      continue;
    result[key] = safe(item, depth + 1);
  }
  return result;
}
export function validRecognitionOutput(
  input: unknown,
  taskType: string,
  taskId: number,
): input is RecognitionOutput {
  const p = recordWithKeys(input, [
    "version",
    "taskType",
    "taskId",
    "events",
    "truncated",
  ]);
  if (
    !p ||
    p.version !== 1 ||
    !allowed(taskType) ||
    p.taskType !== taskType ||
    p.taskId !== taskId ||
    !Number.isSafeInteger(taskId) ||
    taskId < 1 ||
    typeof p.truncated !== "boolean" ||
    !Array.isArray(p.events) ||
    !p.events.length ||
    p.events.length > 10
  )
    return false;
  try {
    return (
      JSON.stringify(p).length <= 128 * 1024 &&
      p.events.every((raw) => {
        const e = recordWithKeys(raw, ["name", "details"]);
        return (
          !!e &&
          typeof e.name === "string" &&
          /^[A-Za-z0-9_:-]{1,80}$/.test(e.name) &&
          !!asRecord(e.details) &&
          JSON.stringify(safe(e.details)) === JSON.stringify(e.details)
        );
      })
    );
  } catch {
    return false;
  }
}
/** Caller supplies matching active native task IDs; these are observations, not account/certification proof. */
export class RecognitionCollector {
  private events: RecognitionOutput["events"] = [];
  private truncated = false;
  constructor(private type: string) {}
  accept(code: number, value: Record<string, unknown>) {
    if (
      !allowed(this.type) ||
      code !== 20003 ||
      typeof value.what !== "string" ||
      !/^[A-Za-z0-9_:-]{1,80}$/.test(value.what) ||
      !asRecord(value.details)
    )
      return;
    try {
      const item = {
        name: value.what,
        details: safe(value.details) as Record<string, unknown>,
      };
      if (
        JSON.stringify(item).length > 64 * 1024 ||
        this.events.length >= 10 ||
        JSON.stringify([...this.events, item]).length > 120 * 1024
      ) {
        this.truncated = true;
        return;
      }
      this.events.push(item);
    } catch {
      this.truncated = true;
    }
  }
  finish(taskId: number): RecognitionOutput | undefined {
    return allowed(this.type) && this.events.length
      ? {
          version: 1,
          taskType: this.type,
          taskId,
          events: structuredClone(this.events),
          truncated: this.truncated,
        }
      : undefined;
  }
}
