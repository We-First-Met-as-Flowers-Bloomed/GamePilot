export function desktopLaunchMode(args: string[]) {
  const plannerUiTest = args.includes("--planner-ui-test");
  const plannerPreview = args.includes("--planner-preview") || plannerUiTest;
  if (plannerPreview && args.includes("--run-device-lanes-once"))
    throw new Error("AI 规划预览不能与真实游戏启动参数同时使用");
  return {
    plannerUiTest,
    plannerPreview,
    smoke: args.includes("--smoke") || plannerPreview,
  };
}
