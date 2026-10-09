import { plannerAwardLabels } from "./agent-configuration";
export function presentAgentParameters(
  gameId: string,
  values: Record<string, unknown>,
): { label: string; value: string }[] {
  const show = (key: string) =>
    values[key] === undefined ? "未提供" : String(values[key]);
  if (gameId === "arknights")
    return [
      {
        label: "客户端",
        value:
          values.clientType === "Official"
            ? "官服"
            : values.clientType === "Bilibili"
              ? "B服"
              : show("clientType"),
      },
      { label: "关卡", value: values.stage ? show("stage") : "未指定" },
      {
        label: "邮件",
        value:
          values.mail === true
            ? "领取"
            : values.mail === false
              ? "不领取"
              : "未提供",
      },
      { label: "理智药", value: show("medicine") },
      { label: "过期理智药", value: show("expiringMedicine") },
      { label: "源石", value: show("stone") },
      {
        label: "附带活动奖励",
        value: Object.keys(plannerAwardLabels).some(
          (key) => typeof values[key] !== "boolean",
        )
          ? "未完整提供"
          : Object.entries(plannerAwardLabels)
              .filter(([key]) => values[key] === true)
              .map(([, label]) => label)
              .join("、") || "全部关闭",
      },
      { label: "时长上限（分钟）", value: show("maxRunMinutes") },
      {
        label: "信用购物",
        value:
          values.creditShopping === true
            ? "开启"
            : values.creditShopping === false
              ? "关闭"
              : "未提供",
      },
    ];
  return Object.entries(values).map(([label, value]) => ({
    label,
    value: String(value),
  }));
}
