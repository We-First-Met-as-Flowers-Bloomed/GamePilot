import { runSavedGameChannel } from "./game-app.mjs";
export function runSavedArknightsChannel(profileDir, laneId, options = {}) {
  return runSavedGameChannel(profileDir, laneId, "arknights", {
    ...options,
    legacyArknights: true,
  });
}
