import { app, BrowserWindow } from "electron";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
app.setPath("userData", join(__dirname, "profile"));
app.commandLine.appendSwitch("disable-gpu");
app
  .whenReady()
  .then(async () => {
    const window = new BrowserWindow({
      width: 1100,
      height: 1100,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    window.webContents.session.webRequest.onBeforeRequest((details, callback) =>
      callback({ cancel: /^https?:/.test(details.url) }),
    );
    await window.loadFile(join(__dirname, "index.html"));
    const result = await window.webContents.executeJavaScript(
      "window.__activityTests",
      true,
    );
    await window.webContents.executeJavaScript(
      "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      true,
    );
    await writeFile(
      join(__dirname, "result.json"),
      JSON.stringify(result, null, 2),
    );
    await writeFile(
      join(__dirname, "activity-stages.png"),
      (await window.webContents.capturePage()).toPNG(),
    );
    await window.webContents.executeJavaScript(
      "window.__showUpgradeSettings()",
      true,
    );
    await window.webContents.executeJavaScript(
      "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      true,
    );
    await writeFile(
      join(__dirname, "operator-upgrade.png"),
      (await window.webContents.capturePage()).toPNG(),
    );
    await window.webContents.executeJavaScript(
      "window.__showCopilotSettings()",
      true,
    );
    await window.webContents.executeJavaScript(
      "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      true,
    );
    await writeFile(
      join(__dirname, "copilot-settings.png"),
      (await window.webContents.capturePage()).toPNG(),
    );
    app.exit(0);
  })
  .catch(async (error) => {
    await writeFile(
      join(__dirname, "error.txt"),
      String(error?.stack ?? error),
    );
    app.exit(1);
  });
