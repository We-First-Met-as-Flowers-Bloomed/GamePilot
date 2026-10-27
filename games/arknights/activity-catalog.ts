import type { ArknightsClientType } from "../../packages/runtime/activity-stage";
import type { ArknightsActivityStage } from "../../packages/protocol/arknights-activity";
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
function timestamp(value: unknown): number {
  if (
    typeof value !== "string" ||
    !/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
  )
    return NaN;
  const iso = value.replaceAll("/", "-").replace(" ", "T") + ".000Z";
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === iso
    ? parsed
    : NaN;
}
const version = (value: unknown) => {
  if (typeof value !== "string" || !/^v?\d+\.\d+\.\d+$/.test(value)) return;
  const parts = value.replace(/^v/, "").split(".").map(Number);
  return parts.every(Number.isSafeInteger) ? parts : undefined;
};
function supports(actual: string, required: unknown) {
  const left = version(actual),
    right = version(required ?? "0.0.0");
  if (!left || !right) return false;
  for (let i = 0; i < 3; i++)
    if (left[i] !== right[i]) return left[i] > right[i];
  return true;
}
function availability(
  now: Date,
  start: number,
  end: number,
  engineVersion: string,
  minimum: unknown,
  route: string,
  routes?: ReadonlySet<string>,
) {
  const at = now.getTime();
  if (!Number.isFinite(at)) return { available: false, reason: "当前时间无效" };
  if (at < start) return { available: false, reason: "尚未开放" };
  if (at >= end) return { available: false, reason: "活动已结束" };
  if (!supports(engineVersion, minimum))
    return { available: false, reason: "需要 MaaCore " + String(minimum) };
  if (routes && !routes.has(route))
    return { available: false, reason: "官方导航尚未包含此路线，请重新同步" };
  return { available: true };
}
/** Only open, supported normal fight routes contained in the verified navigation can be followed. */
export function currentOfficialActivityStage(
  data: unknown,
  client: ArknightsClientType,
  now: Date,
  engineVersion: string,
  routes?: ReadonlySet<string>,
): { stage: string; name: string } | null {
  const stage = officialActivityStages(data, client, now, engineVersion, routes)
    .filter(
      (value) => value.available && /^[A-Za-z]{1,6}-\d{1,2}$/.test(value.stage),
    )
    .sort((a, b) => b.startsAt.localeCompare(a.startsAt))[0];
  return stage ? { stage: stage.stage, name: stage.activity } : null;
}
export function officialActivityStages(
  data: unknown,
  client: ArknightsClientType,
  now: Date,
  engineVersion: string,
  routes?: ReadonlySet<string>,
): ArknightsActivityStage[] {
  const server = object(
    object(data)?.[client === "Bilibili" ? "Official" : client],
  );
  const result: ArknightsActivityStage[] = [];
  for (const group of Object.values(object(server?.sideStoryStage) ?? {})) {
    const value = object(group),
      activity = object(value?.Activity);
    const start = timestamp(activity?.UtcStartTime),
      end = timestamp(activity?.UtcExpireTime);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
      continue;
    for (const input of Array.isArray(value?.Stages) ? value.Stages : []) {
      const item = object(input);
      if (
        typeof item?.Value !== "string" ||
        !/^(?:[A-Za-z]{1,6}-\d{1,2}|SSReopen-[A-Za-z]{1,6})$/.test(item.Value)
      )
        continue;
      result.push({
        stage: item.Value,
        label: typeof item.Display === "string" ? item.Display : item.Value,
        activity:
          typeof activity?.StageName === "string"
            ? activity.StageName
            : "活动关卡",
        drop: typeof item.Drop === "string" ? item.Drop : "",
        startsAt: new Date(start).toISOString(),
        endsAt: new Date(end).toISOString(),
        ...availability(
          now,
          start,
          end,
          engineVersion,
          value?.MinimumRequired,
          item.Value,
          routes,
        ),
      });
    }
  }
  return result;
}
export function officialActivityMiniGames(
  data: unknown,
  client: ArknightsClientType,
  now: Date,
  engineVersion: string,
  routes?: ReadonlySet<string>,
): ArknightsActivityStage[] {
  const server = object(
    object(data)?.[client === "Bilibili" ? "Official" : client],
  );
  const items = Array.isArray(server?.miniGame) ? server.miniGame : [];
  return items.flatMap((input) => {
    const item = object(input),
      start = timestamp(item?.UtcStartTime),
      end = timestamp(item?.UtcExpireTime);
    if (
      typeof item?.Value !== "string" ||
      !/^[A-Za-z][A-Za-z0-9_@-]{0,119}$/.test(item.Value) ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end <= start
    )
      return [];
    const label = typeof item.Display === "string" ? item.Display : item.Value;
    return [
      {
        stage: item.Value,
        label,
        activity: label,
        drop: "",
        tip: typeof item.Tip === "string" ? item.Tip : "",
        startsAt: new Date(start).toISOString(),
        endsAt: new Date(end).toISOString(),
        ...availability(
          now,
          start,
          end,
          engineVersion,
          item.MinimumRequired,
          item.Value,
          routes,
        ),
      },
    ];
  });
}
