import { expect, it } from "vitest";
import type { DeviceLane } from "../packages/protocol";
import type { ArknightsAutomationConfig, ArknightsJob } from "../packages/protocol/arknights-automation";

const protocol = () => import("../packages/protocol/arknights-automation").catch(() => undefined);
const job = (): ArknightsJob => ({ id: "morning", name: "早间", laneId: "ark-a", enabled: true, time: "08:00", weekdays: [0, 1, 2, 3, 4, 5, 6], skillIds: ["login", "award"], catchUp: true });
const config = (): ArknightsAutomationConfig => ({ version: 1, enabled: true, jobs: [job()] });

it("validates independent jobs and owns the input arrays", async () => {
  const validate = (await protocol())?.validateArknightsAutomation;
  expect(validate).toBeTypeOf("function");
  const input = config();
  const result = validate!(input);
  expect(result).toEqual(input);
  input.jobs[0].skillIds.push("fight");
  expect(result.jobs[0].skillIds).toEqual(["login", "award"]);
});
it.each([
  { enabled: "true" }, { version: 2 }, { extra: true }, { jobs: null },
  { jobs: [{ ...job(), time: "8:00" }] }, { jobs: [{ ...job(), time: "24:00" }] },
  { jobs: [{ ...job(), id: "../escape" }] }, { jobs: [{ ...job(), laneId: "a b" }] },
  { jobs: [{ ...job(), weekdays: [] }] }, { jobs: [{ ...job(), weekdays: [7] }] },
  { jobs: [{ ...job(), weekdays: [1, 1] }] }, { jobs: [{ ...job(), weekdays: [1.5] }] },
  { jobs: [{ ...job(), skillIds: [] }] }, { jobs: [{ ...job(), skillIds: ["unknown"] }] },
  { jobs: [{ ...job(), skillIds: ["login", "login"] }] },
  { jobs: [{ ...job(), catchUp: 1 }] }, { jobs: [{ ...job(), name: "\u0000" }] },
  { jobs: [{ ...job(), enabled: "true" }] }, { jobs: [job(), job()] },
  { jobs: [{ ...job(), unsupported: true }] },
])("rejects malformed or ambiguous config %j", async (patch) => {
  const validate = (await protocol())?.validateArknightsAutomation;
  expect(validate).toBeTypeOf("function");
  expect(() => validate!({ ...config(), ...patch })).toThrow();
});
it("builds disabled morning/evening defaults for each enabled Ark channel only", async () => {
  const defaults = (await protocol())?.defaultArknightsAutomation;
  expect(defaults).toBeTypeOf("function");
  const lane = (id: string, ark: boolean, enabled = true) => ({ id, name: id, enabled, arknights: { enabled: ark } }) as DeviceLane;
  const value = defaults!([lane("ark-a", true), lane("yys", false), lane("ark-b", true), lane("off", true, false)]);
  expect(value.enabled).toBe(false);
  expect(value.jobs.map((item) => [item.laneId, item.time])).toEqual([["ark-a", "08:00"], ["ark-a", "20:00"], ["ark-b", "08:00"], ["ark-b", "20:00"]]);
  expect(value.jobs[0].skillIds).toEqual(["login", "recruit", "fight", "infrastructure", "friends", "award"]);
  expect(value.jobs[1].skillIds).toEqual(["login", "recruit", "fight", "infrastructure", "award"]);
  expect(new Set(value.jobs.map((item) => item.id)).size).toBe(4);
});
