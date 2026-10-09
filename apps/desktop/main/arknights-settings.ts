import { replaceFile } from "./replace-file";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { validateArknightsCapabilities } from "../../../games/arknights/capabilities";
import {
  defaultArknightsProfiles,
  validateArknightsConfig,
  validateArknightsProfiles,
  type ArknightsProfiles,
} from "../../../games/arknights/config";

export class ArknightsStore {
  private writes: Promise<void> = Promise.resolve();
  constructor(private path: string) {}
  async read(): Promise<ArknightsProfiles> {
    await this.writes;
    try {
      const value = JSON.parse(await readFile(this.path, "utf8"));
      if (value?.version === 1) return validateArknightsProfiles(value);
      const config = validateArknightsConfig(value);
      const migrated: ArknightsProfiles = {
        version: 1,
        activeProfileId: "default",
        profiles: [{ id: "default", name: "当前账号", ...config }],
      };
      await this.queueWrite(migrated);
      return migrated;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return structuredClone(defaultArknightsProfiles);
      throw new Error("设置文件损坏，请检查配置文件后重试", { cause: error });
    }
  }
  async save(input: unknown): Promise<ArknightsProfiles> {
    const settings = validateArknightsProfiles(input);
    for (const profile of settings.profiles)
      validateArknightsCapabilities(profile, ["award"]);
    await this.queueWrite(settings);
    return settings;
  }
  private async queueWrite(settings: ArknightsProfiles): Promise<void> {
    const save = this.writes.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(
        `${this.path}.tmp`,
        JSON.stringify(settings, null, 2),
        "utf8",
      );
      await replaceFile(`${this.path}.tmp`, this.path);
    });
    this.writes = save.catch(() => {});
    await save;
  }
}
