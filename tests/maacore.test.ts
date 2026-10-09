import { describe, expect, it } from "vitest";
import { MaaCoreClient } from "../packages/runtime/maacore";
describe("MaaCore isolated process", () => {
  it("rejects a missing bridge and closes safely", async () => {
    const client = new MaaCoreClient(
      "Z:/missing/GamePilot.MaaBridge.exe",
      ".",
      ".",
    );
    await expect(client.info()).rejects.toThrow();
    await client.close();
  });
  it("does not start an already cancelled task", async () => {
    const client = new MaaCoreClient("Z:/missing.exe", ".", ".");
    await expect(
      client.runTask("Award", {}, AbortSignal.abort(), () => {}),
    ).rejects.toThrow(/cancel/i);
    await client.close();
  });
});
