import { registerGameAutomationIpc } from "./game-automation";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile, lstat } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import type { DeviceLane } from "../../../../packages/protocol";
import type { ArknightsProfiles } from "../../../../games/arknights/config";
import { importMaaGuiConfig } from "../../../../games/arknights/maa-gui-import";
import {
  validateArknightsAutomation,
  type RunArknightsJobInput,
} from "../../../../packages/protocol/arknights-automation";
import { agentObject } from "../../../../packages/protocol/agent";
import { freezeArknightsJob } from "../arknights-job-snapshot";
import type { ArknightsAutomationService } from "../arknights-automation";
import type { InternalActivityStageResolver } from "../internal-activity-stage";

interface Ports {
  register(channel: string, handler: (input: unknown) => unknown): void;
  dataDir: string;
  service: Pick<ArknightsAutomationService, "read" | "save" | "runNow">;
  activity: Pick<InternalActivityStageResolver, "catalog">;
  readLanes(): Promise<DeviceLane[]>;
  readProfiles(): Promise<ArknightsProfiles>;
  busy(): boolean;
  runBusy?(): boolean;
  withConfiguring<T>(action: () => Promise<T>, purpose?: "plans"): Promise<T>;
  chooseMaaFile(): Promise<string | undefined>;
}
/** Account settings, plans and imports share one guarded configuration boundary. */
export function registerArknightsAutomationIpc(p: Ports) {
  registerGameAutomationIpc({
    ...p,
    prefix: "arknights",
    validate: validateArknightsAutomation,
    validateJob: async (job) => {
      const lane = (await p.readLanes()).find((item) => item.id === job.laneId);
      if (!lane?.arknights.enabled) throw Error("计划绑定的方舟账号不存在");
      if (job.enabled)
        freezeArknightsJob(
          { ...lane, enabled: true },
          await p.readProfiles(),
          job,
        );
    },
  });
  p.register("gp:arknights-activity", (input) => {
    const value = agentObject(input, ["clientType", "refresh"]);
    if (
      (value.clientType !== "Official" && value.clientType !== "Bilibili") ||
      (value.refresh !== undefined && typeof value.refresh !== "boolean")
    )
      throw Error("活动关卡查询参数无效");
    return p.activity.catalog(value.clientType, value.refresh === true);
  });
  p.register("gp:arknights-maa-import", async (input) => {
    if (p.busy()) throw Error("请在任务结束后导入设置");
    return p.withConfiguring(async () => {
      const value = agentObject(input, ["profileId"]);
      const profile = (await p.readProfiles()).profiles.find(
        (item) => item.id === value.profileId,
      );
      if (!profile) throw Error("方舟账号档案不存在");
      const file = await p.chooseMaaFile();
      if (!file) return null;
      if ((await stat(file)).size > 2 * 1024 * 1024)
        throw Error("MAA 配置超过大小限制");
      const { id: _id, name: _name, ...base } = profile;
      const imported = importMaaGuiConfig(
        JSON.parse(await readFile(file, "utf8")),
        base,
      );
      if (imported.customInfrastructureFile) {
        const custom = resolve(
          dirname(file),
          imported.customInfrastructureFile,
        );
        if ((await stat(custom)).size > 2 * 1024 * 1024)
          throw Error("基建排班文件超过大小限制");
        const content = await readFile(custom, "utf8"),
          parsed = JSON.parse(content);
        if (
          !parsed ||
          typeof parsed !== "object" ||
          Array.isArray(parsed) ||
          !Array.isArray(parsed.plans) ||
          !parsed.plans.length
        )
          throw Error("基建排班格式无效");
        const hash = createHash("sha256").update(content).digest("hex"),
          ownedDir = join(p.dataDir, "arknights-infrastructure"),
          owned = join(ownedDir, `${hash}.json`);
        await mkdir(ownedDir, { recursive: true });
        await writeFile(owned, content, { encoding: "utf8", flag: "wx" }).catch(
          async (error) => {
            if (error.code !== "EEXIST") throw error;
            if (
              (await lstat(owned)).isSymbolicLink() ||
              (await readFile(owned, "utf8")) !== content
            )
              throw Error("App 内基建排班摘要不匹配");
          },
        );
        imported.config.taskOptions!.infrastructure!.filename = owned;
      }
      return { config: imported.config, warnings: imported.warnings };
    });
  });
}
