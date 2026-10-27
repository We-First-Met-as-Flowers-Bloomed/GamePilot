import { useRef } from "react";
import { canonical } from "../../../../packages/protocol/canonical";

/**
 * 事件与补读去重。同一份数据只提交一次；多会话调用方把scope纳入比较键。
 */
export function useDistinctValue(): (value: unknown) => boolean {
  const last = useRef<string | undefined>(undefined);
  return (value: unknown) => {
    const key = canonical(value);
    if (key === last.current) return false;
    last.current = key;
    return true;
  };
}
