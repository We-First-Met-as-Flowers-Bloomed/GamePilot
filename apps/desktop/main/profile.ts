import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";

interface ProfileApp {
  getPath(name: "home" | "appData" | "userData"): string;
  setPath(name: "userData", value: string): void;
}

// AppData can be redirected by an MSIX launcher. Keep one identity across launchers.
export function initializeProfile(app: ProfileApp) {
  const legacy = app.getPath("userData");
  const defaultPath = join(app.getPath("appData"), "GamePilot");
  if (resolve(legacy).toLowerCase() !== resolve(defaultPath).toLowerCase())
    return; // Explicit smoke/preview profiles remain isolated.
  const home = app.getPath("home");
  const target = join(home, ".gamepilot");
  if (existsSync(target)) {
    app.setPath("userData", target);
    return;
  }
  const staging = mkdtempSync(join(home, ".gamepilot-migration-"));
  try {
    for (const file of [
      "settings.json",
      "automation.json",
      "scheduler.json",
      "history.json",
      "arknights.json",
    ]) {
      let contents: string;
      try {
        contents = readFileSync(join(legacy, file), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      JSON.parse(contents);
      // Reading/writing bytes avoids inheriting EFS encryption from MSIX profiles.
      writeFileSync(join(staging, file), contents, { flag: "wx" });
    }
    try {
      renameSync(staging, target);
    } catch (error) {
      if (!existsSync(target)) throw error;
    }
  } finally {
    // Remove only our unique, verified direct child of the profile's parent.
    if (dirname(resolve(staging)) === resolve(home))
      rmSync(staging, { recursive: true, force: true });
  }
  app.setPath("userData", target);
}
