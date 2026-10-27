export function patchStartupAnnouncements(tasks) {
  const next = tasks?.CloseAnnos?.next;
  if (
    !Array.isArray(next) ||
    !next.includes("CloseAnno") ||
    !next.includes("TodaysSupplies")
  )
    throw Error("MAA 公告入口结构变化，拒绝覆盖资源，请重新验证适配");
  const result = structuredClone(tasks);
  const name = "GamePilotMooncakeAnnouncement";
  result.CloseAnnos.next = [name, ...next.filter((entry) => entry !== name)];
  // Verified 1920x1080 scene, expressed in MaaCore's 1280x720 coordinates.
  // Only dismiss this observed event; never press its reward/crafting button.
  result[name] = {
    algorithm: "OcrDetect",
    text: ["月饼烘焙小教程"],
    roi: [530, 165, 240, 45],
    action: "ClickRect",
    specificRect: [1158, 83, 21, 21],
    postDelay: 1200,
    maxTimes: 3,
    exceededNext: ["MainThemes#next"],
    next: ["MainThemes#next", "CloseAnnos#next"],
  };
  return result;
}

export function patchInfrastructureNavigation(tasks) {
  const next = tasks?.InfrastBegin?.next;
  if (
    !Array.isArray(next) ||
    !next.includes("Infrast") ||
    !next.includes("InfrastEnteredFlag")
  )
    throw Error("MAA 基建导航结构变化，拒绝覆盖资源，请重新验证适配");
  const result = structuredClone(tasks);
  const name = "GamePilotInfrastStay";
  result.InfrastBegin.next = [name, ...next.filter((entry) => entry !== name)];
  // Verified exit-base prompt at 1920x1080, expressed in 1280x720.
  // Cancel leaving the base; this never confirms changes to operator presets.
  result[name] = {
    algorithm: "OcrDetect",
    text: ["是否确认离开罗德岛基建"],
    roi: [440, 280, 410, 90],
    action: "ClickRect",
    specificRect: [425, 480, 30, 30],
    postDelay: 1000,
    maxTimes: 3,
    // At the limit, require the actual base screen instead of silently stopping
    // the task with the dialog still open. A missing flag fails the native chain.
    exceededNext: ["InfrastEnteredFlag"],
    next: ["InfrastBegin#next"],
  };
  return result;
}
