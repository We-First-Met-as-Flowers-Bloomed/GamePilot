import { expect, it } from "vitest";
import { inspectArknightsDevice } from "../games/arknights/inspect-device";
import { defaultArknightsConfig } from "../games/arknights/config";
import type { DeviceInspection } from "../packages/protocol/recovery";
import type { Rect } from "../packages/runtime/device";
const device = { name: "MuMu", adbPath: "adb.exe", address: "127.0.0.1:16384" };
const sample = (
  foregroundPackage = "com.hypergryph.arknights",
): DeviceInspection => ({
  address: device.address,
  observedAt: new Date().toISOString(),
  image: "data:image/png;base64,cG5n",
  foregroundPackage,
  accountVerified: false,
  pageVerified: false,
});
const frame = { width: 1920, height: 1080, texts: [] };
it("uses a bounded UID crop from the same home image when full-frame OCR misses white text", async () => {
  const calls: (Rect | undefined)[] = [];
  const config = { ...defaultArknightsConfig, expectedUid: "123456789" };
  const home = {
    ...frame,
    texts: ["任务", "基建", "公开招募"].map((text, i) => ({
      text,
      box: [1050 + i * 200, 900, 150, 30] as Rect,
      score: 0.99,
    })),
  };
  const r = await inspectArknightsDevice(device, config, {
    capture: async () => sample(),
    wait: async () => {},
    recognize: async (_image, roi) => {
      calls.push(roi);
      return roi
        ? { ...frame, texts: [{ text: "123456789", box: roi, score: 0.99 }] }
        : home;
    },
  });
  expect(calls).toEqual([
    undefined,
    [114, 635, 126, 24],
    undefined,
    [114, 635, 126, 24],
  ]);
  expect(r.accountVerified).toBe(true);
});
it("recognizes exactly the captured images, with two read-only captures", async () => {
  const images: string[] = [];
  let captures = 0;
  const result = await inspectArknightsDevice(device, defaultArknightsConfig, {
    capture: async () => {
      captures++;
      return sample();
    },
    recognize: async (img) => {
      images.push(img);
      return frame;
    },
    wait: async () => {},
  });
  expect(captures).toBe(2);
  expect(images).toEqual([sample().image, sample().image]);
  expect(result.accountVerified).toBe(false);
  expect(result.arknights?.page).toBe("unknown");
});
it("does not initialize OCR on a different game and never launches the target game", async () => {
  let reads = 0;
  const r = await inspectArknightsDevice(device, defaultArknightsConfig, {
    capture: async () => sample("com.netease.onmyoji"),
    recognize: async () => {
      reads++;
      return frame;
    },
    wait: async () => {},
  });
  expect(reads).toBe(0);
  expect(r.arknights?.page).toBe("other-app");
});
it("returns the screenshot with an explicit unverified error if OCR fails", async () => {
  const r = await inspectArknightsDevice(device, defaultArknightsConfig, {
    capture: async () => sample(),
    recognize: async () => {
      throw Error("OCR unavailable");
    },
    wait: async () => {},
  });
  expect(r.image).toBe(sample().image);
  expect(r.accountVerified).toBe(false);
  expect(r.recognitionError).toContain("OCR unavailable");
});
it("does not reuse a successful earlier frame if a later capture fails", async () => {
  let n = 0;
  const r = await inspectArknightsDevice(device, defaultArknightsConfig, {
    capture: async () => {
      if (n++) throw Error("disconnected");
      return sample();
    },
    recognize: async () => frame,
    wait: async () => {},
  });
  expect(r.accountVerified).toBe(false);
  expect(r.pageVerified).toBe(false);
  expect(r.recognitionError).toContain("disconnected");
});
