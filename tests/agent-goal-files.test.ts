import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { agentGoalFiles } from "../apps/desktop/main/agent-goal-files";

it("saves atomically and only treats a missing goal file as empty", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamepilot-goals-"));
  const file = join(directory, "goals.json");
  const files = agentGoalFiles(file);
  try {
    expect(await files.load()).toBeUndefined();
    const store = { version: 1 as const, revision: 1, goals: [] };
    await files.save(store);
    expect(await files.load()).toEqual(store);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(store);
    await writeFile(file, "{truncated", "utf8");
    await expect(files.load()).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
