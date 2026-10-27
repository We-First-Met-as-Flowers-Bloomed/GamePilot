import {
  defaultDeviceLanes,
  validateDeviceLanes,
  type DeviceLanes,
} from "../../../packages/protocol";
import { AtomicJsonStore } from "./atomic-json-store";
import { games } from "../../../games/registry";
import { validateRoutine } from "../../../packages/protocol/routine";
import { copyFile, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { migrateAccountChannels } from "./channel-migration";

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

/**
 * Read-side tolerance: stored routines may reference skills from a newer or
 * private build (e.g. oboroguruma). Reading must never crash the app over a
 * stale skill id — strip unknown steps and drop routines that no longer
 * validate, while save() keeps strict validation.
 */
const readWarnings = new Set<string>();
function warnReadOnce(key: string, message: string) {
  if (readWarnings.has(key)) return;
  readWarnings.add(key);
  console.warn(message);
}

function validatedForRead(input: unknown) {
  const value = validateDeviceLanes(input);
  for (const lane of value.lanes)
    for (const id of ["arknights", "onmyoji"] as const) {
      const routine = lane[id].routine;
      if (!routine) continue;
      const game = games.find((g) => g.id === id)!;
      try {
        validateRoutine(routine, game);
        continue;
      } catch {
        // fall through to sanitization
      }
      const known = routine.steps.filter((s) =>
        game.skills.some((skill) => skill.id === s.skillId),
      );
      const dropped = routine.steps.length - known.length;
      if (dropped > 0)
        warnReadOnce(
          `${id}:unknown`,
          `device-lanes: ${id} 任务清单包含 ${dropped} 个当前版本不认识的技能，读取时已跳过`,
        );
      const candidate = { ...routine, steps: known };
      try {
        lane[id].routine = validateRoutine(candidate, game);
      } catch (error) {
        warnReadOnce(
          `${id}:broken`,
          `device-lanes: ${id} 任务清单无法修复，读取时忽略：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        lane[id].routine = undefined;
      }
    }
  return value;
}

type LegacyLaneSettings = Parameters<typeof defaultDeviceLanes>[0];

export class DeviceLaneStore {
  private store: AtomicJsonStore<DeviceLanes>;
  private operations: Promise<unknown> = Promise.resolve();

  constructor(
    file: string,
    private legacy: () => LegacyLaneSettings | Promise<LegacyLaneSettings>,
  ) {
    this.store = new AtomicJsonStore<DeviceLanes>(file, {
      // Read path is tolerant (stale skills from newer builds are sanitized
      // in validatedForRead); save() re-checks strictly before delegating.
      validate: validatedForRead,
      onCorrupt: (error) => {
        throw new Error("账号渠道配置损坏，已停止读取和执行（原文件保留）", {
          cause: error,
        });
      },
    });
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation);
    this.operations = result.catch(() => {});
    return result;
  }

  private async readSource(): Promise<Buffer | undefined> {
    try {
      return await readFile(this.store.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async backupLegacy(source: Buffer | undefined): Promise<void> {
    if (!source || !(await readFile(this.store.path)).equals(source))
      throw new Error("渠道配置在读取后已变化，已停止迁移，请重新加载");
    const copy = async (destination: string) => {
      try {
        await copyFile(this.store.path, destination, constants.COPYFILE_EXCL);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      return (await readFile(destination)).equals(source);
    };
    const first = this.store.path + ".pre-account-channels-v1.bak";
    if (!(await copy(first))) {
      const hash = createHash("sha256").update(source).digest("hex");
      if (
        !(await copy(this.store.path + `.pre-account-channels-v1.${hash}.bak`))
      )
        throw new Error("渠道迁移备份内容不一致，已保留原配置并停止迁移");
    }
    if (!(await readFile(this.store.path)).equals(source))
      throw new Error("渠道配置在备份时已变化，已停止迁移，请重新加载");
  }

  read(): Promise<DeviceLanes> {
    return this.serialized(async () => {
      const source = await this.readSource();
      const stored = await this.store.load();
      if (stored === undefined)
        return migrateAccountChannels(defaultDeviceLanes(await this.legacy()));
      if (stored.version === 2) return validatedForRead(stored);
      const channels = migrateAccountChannels(stored);
      await this.backupLegacy(source);
      await this.store.save(channels);
      return channels;
    });
  }

  save(input: unknown): Promise<DeviceLanes> {
    return this.serialized(async () => {
      const value = migrateAccountChannels(validated(input));
      const source = await this.readSource();
      const stored = await this.store.load();
      if (stored?.version === 1) await this.backupLegacy(source);
      await this.store.save(value);
      return value;
    });
  }
}
