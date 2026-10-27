/** Stable public aliases: preserve lane-a…lane-z, then continue lane-aa, lane-ab… */
export function agentLaneAlias(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0)
    throw new Error("设备槽位别名索引无效");
  let value = index + 1;
  let suffix = "";
  while (value > 0) {
    value--;
    suffix = String.fromCharCode(97 + value % 26) + suffix;
    value = Math.floor(value / 26);
  }
  return `lane-${suffix}`;
}
