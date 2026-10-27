import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  syncActivityNavigation,
  readActivityNavigation,
} from "../packages/runtime/maa-activity-resource";

it("stores immutable official navigation with a verified digest and rejects modified resources", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamepilot-activity-"));
  const now = 1792936000000;
  const raw = JSON.stringify({
    "EV-8": { algorithm: "JustReturn", next: ["EV-8@SideStoryStage"] },
  });
  const resource = await syncActivityNavigation(root, {
    now: () => now,
    fetchData: async () => ({ raw, data: JSON.parse(raw) }),
  });
  expect(resource).toBeDefined();
  expect(
    await readFile(
      join(resource!.directory, "resource", "tasks", "activity.json"),
      "utf8",
    ),
  ).toBe(raw);
  expect(await readActivityNavigation(root, now)).toEqual(resource);
  await writeFile(
    join(resource!.directory, "resource", "tasks", "activity.json"),
    "{}",
  );
  expect(await readActivityNavigation(root, now)).toBeUndefined();
});
it("retains a verified recent resource on network failure but never uses future or expired metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamepilot-activity-"));
  const now = 1792936000000,
    raw = "{}";
  const resource = await syncActivityNavigation(root, {
    now: () => now,
    fetchData: async () => ({ raw, data: {} }),
  });
  expect(
    await syncActivityNavigation(root, {
      now: () => now + 60000,
      fetchData: async () => {
        throw Error("offline");
      },
    }),
  ).toEqual(resource);
  expect(await readActivityNavigation(root, now - 1)).toBeUndefined();
  expect(await readActivityNavigation(root, now + 86400001)).toBeUndefined();
});
