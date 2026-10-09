import { replaceFile } from "./replace-file";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  validateAutomation,
  type AutomationSettings,
} from "../../../packages/protocol";
export class AutomationStore {
  private writes: Promise<void> = Promise.resolve();
  constructor(private file: string) {}
  async read(): Promise<AutomationSettings> {
    await this.writes;
    try {
      return validateAutomation(JSON.parse(await readFile(this.file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return validateAutomation({ launchEmulator: true });
      throw new Error("启动设置损坏，请检查 automation.json", { cause: error });
    }
  }
  async save(input: unknown) {
    const value = validateAutomation(input);
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
