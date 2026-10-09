import { app, safeStorage } from "electron";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdirSync, copyFileSync } from "node:fs";
import { ModelProviderStore } from "../../apps/desktop/main/model-provider";
import { readConfiguredSnapshot } from "../../packages/agent/configured";
import { createAgentTools } from "../../packages/agent/tools";
import { planWithDsh } from "../../packages/agent/dsh-planner";
import type { PlannerStreamEvent } from "../../packages/protocol/agent-planner";
import { AgentToolError } from "../../packages/protocol/agent";

const root = process.cwd();
const evidence = join(root, "artifacts", "dsh-live-readonly");
app.setName("GamePilot");
app.setPath("userData", join(evidence, "electron-profile"));
app.disableHardwareAcceleration();
// Electron safeStorage uses the profile's opaque local encryption state. Copy
// only that encrypted state into the isolated verifier, never a plaintext key.
mkdirSync(app.getPath("userData"), { recursive: true });
copyFileSync(
  join(app.getPath("home"), ".gamepilot", "Local State"),
  join(app.getPath("userData"), "Local State"),
);
void app
  .whenReady()
  .then(async () => {
    await mkdir(evidence, { recursive: true });
    const profile = join(app.getPath("home"), ".gamepilot");
    const provider = new ModelProviderStore(
      join(profile, "model-provider.json"),
      safeStorage,
    );
    const connection = await provider.resolve();
    if (connection.provider !== "compatible" || !connection.apiKey)
      throw new AgentToolError("MODEL_UNAVAILABLE", "未配置兼容模型");
    const configured = await readConfiguredSnapshot(profile, { history: true });
    const events: PlannerStreamEvent[] = [];
    const sessionId = `readonly-${Date.now()}`;
    const results = [];
    for (const prompt of [
      "本次仅只读验证。先调用list_capabilities和get_environment，再读取明日方舟和阴阳师内置skill。用中文简述两个账号保存的日常任务与权限限制。不要编译、启动、修改或恢复游戏。",
      "继续这次只读验证：请再调用get_environment确认数据来自存储配置与记录，说明为什么这不能证明此刻设备在线和游戏任务已完成。不要执行游戏。",
    ])
      results.push(
        await planWithDsh(createAgentTools(configured.snapshot), {
          connection: {
            baseUrl: connection.baseUrl,
            model: connection.model,
            apiKey: connection.apiKey,
          },
          prompt,
          at: new Date().toISOString(),
          sessionId,
          resume: true,
          runtime: {
            directory: join(
              root,
              "integrations",
              "deepseek-harness",
              "runtime",
            ),
            home: join(evidence, "dsh-home"),
          },
          onEvent: (event) => events.push(event),
        }),
      );
    if (
      results.some((r) => r.execution !== "not-started" || r.draft) ||
      !results[0].trace.some((t) => t.tool === "read_skill" && t.success) ||
      !results[1].trace.some((t) => t.tool === "get_environment" && t.success)
    )
      throw new AgentToolError(
        "LIVE_READONLY_INCOMPLETE",
        "模型未完成规定只读工具验证",
      );
    await writeFile(
      join(evidence, "result.json"),
      JSON.stringify(
        {
          scope:
            "Real saved provider API + official DSH SDK/core; stored configured/recorded inputs; no game effect tools registered; isolated runtime session and Electron profile.",
          model: connection.model,
          sessionId,
          results,
          events,
        },
        null,
        2,
      ),
    );
    console.log(
      `DSH real provider passed: ${results.length} turns, ${results.reduce((n, r) => n + r.trace.length, 0)} read-only tools; no game effects registered.`,
    );
    app.exit(0);
  })
  .catch(async (error) => {
    await mkdir(evidence, { recursive: true });
    const code =
      error instanceof AgentToolError ? error.code : "LIVE_CHECK_FAILED";
    await writeFile(
      join(evidence, "error.json"),
      JSON.stringify({
        code,
        scope: "Read-only model verification; no game effect tools registered",
      }),
    );
    console.error(`DSH live check failed (${code}); credentials omitted.`);
    app.exit(1);
  });
