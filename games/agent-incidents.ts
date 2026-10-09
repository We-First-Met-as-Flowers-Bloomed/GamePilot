import type { IncidentCode } from "../packages/protocol/agent-incident";

/** Local text matching returns only fixed codes; text is never model input. */
export function gameIncidentCodes(
  gameId: string,
  text: string,
): IncidentCode[] {
  const codes: IncidentCode[] = [];
  if (gameId === "arknights" && /CloseAnno|月饼烘焙小教程/.test(text))
    codes.push("ark-announcement");
  if (gameId === "onmyoji") {
    if (/寄养.*(?:扫描|好友)|好友列表.*(?:扫描|上限)/.test(text))
      codes.push("foster-list-progress");
    if (/寄养完成后未能返回庭院/.test(text)) codes.push("foster-return");
  }
  return codes;
}
