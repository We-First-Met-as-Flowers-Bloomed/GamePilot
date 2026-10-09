import { replaceFile } from "./replace-file";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { validateSettings, type Settings } from "../../../packages/protocol";
export const defaultSettings: Settings = {
  adbPath: "",
  address: "",
  modelEndpoint: "",
  modelName: "",
};
export class SettingsStore {
  private writes: Promise<void> = Promise.resolve();
  constructor(private path: string) {}
  async read(): Promise<Settings> {
    await this.writes;
    try {
      return validateSettings(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { ...defaultSettings };
      throw new Error("设置文件损坏，请检查配置文件后重试", { cause: error });
    }
  }
  async save(input: unknown): Promise<Settings> {
    const settings = validateSettings(input);
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
    return settings;
  }
}
