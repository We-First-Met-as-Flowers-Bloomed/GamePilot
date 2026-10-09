import { createRoot } from "react-dom/client";
import { PlannerExecution } from "../../../apps/desktop/renderer/components/PlannerExecution";
import "../../../apps/desktop/renderer/theme.css";
import "../../../apps/desktop/renderer/styles.css";
import "../../../apps/desktop/renderer/agent-planner.css";

const root = createRoot(document.getElementById("root")!);
let generation = 0;
// Test navigation remounts the real component without replacing its IPC API.
(window as any).mountConfirmation = (requestId = "ui-confirmation-1") => {
  root.render(
    <main style={{ padding: 32, maxWidth: 1440, margin: "0 auto" }}>
      <h1>AI 草稿确认 · 隔离测试</h1>
      <p>两个虚构账号；执行器为测试替身，不连接游戏或模型。</p>
      <PlannerExecution
        key={++generation}
        api={(window as any).gamepilot}
        target={{ requestId, planHash: "a".repeat(64) }}
      />
    </main>,
  );
};
(window as any).mountConfirmation();
