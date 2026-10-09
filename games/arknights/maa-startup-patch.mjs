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
