import { dirname } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  defaultDeviceLanes,
  validateDeviceLanes,
  type DeviceLanes,
} from "../../../packages/protocol";
import { replaceFile } from "./replace-file";
import { games } from "../../../games/registry";
import { validateRoutine } from "../../../packages/protocol/routine";

function validated(input: unknown) {
  const value = validateDeviceLanes(input);
  for (const lane of value.lanes)
    for (const id of ["arknights", "onmyoji"] as const) {
      const routine = lane[id].routine;
      if (routine)
        validateRoutine(
          routine,
          games.find((g) => g.id === id)!,
        );
    }
  return value;
}

type LegacyLaneSettings = Parameters<typeof defaultDeviceLanes>[0];

export class DeviceLaneStore {
  private writes: Promise<void> = Promise.resolve();
  constructor(
    private file: string,
    private legacy: () => LegacyLaneSettings | Promise<LegacyLaneSettings>,
  ) {}

  async read(): Promise<DeviceLanes> {
    await this.writes;
    try {
      return validated(JSON.parse(await readFile(this.file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return defaultDeviceLanes(await this.legacy());
      throw new Error("设备槽位配置损坏，请检查 device-lanes.json", {
        cause: error,
      });
    }
  }

  async save(input: unknown): Promise<DeviceLanes> {
    const value = validated(input);
    const task = this.writes.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(this.file + ".tmp", JSON.stringify(value, null, 2));
      await replaceFile(this.file + ".tmp", this.file);
    });
    this.writes = task.catch(() => {});
    await task;
    return value;
  }
}
