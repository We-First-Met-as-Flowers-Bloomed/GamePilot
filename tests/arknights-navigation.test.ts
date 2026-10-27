import { expect, it, vi } from "vitest";
import { returnArknightsHome } from "../games/arknights/navigation";
it("does not navigate a profile shell without its own stable ID", async () => {
  const ports = harness(["profile"]);
  ports.inspect.mockImplementation(async () => {
    const c = capture("profile");
    for (const f of c.arknights!.frames) f.uid = undefined;
    return c;
  });
  await expect(
    returnArknightsHome(device, config, new AbortController().signal, ports),
  ).rejects.toThrow();
  expect(ports.back).not.toHaveBeenCalled();
});
it("does not use an old screenshot if OCR finishes much later", async () => {
  let now = 100000;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const ports = harness(["friends-list"]);
  ports.inspect.mockImplementation(async () => {
    const c = capture("friends-list");
    c.observedAt = new Date(now).toISOString();
    now += 60000;
    return c;
  });
  try {
    await expect(
      returnArknightsHome(device, config, new AbortController().signal, ports),
    ).rejects.toThrow();
    expect(ports.back).not.toHaveBeenCalled();
  } finally {
    clock.mockRestore();
  }
});
import { defaultArknightsConfig } from "../games/arknights/config";
import type { ArknightsPage } from "../games/arknights/inspection";
import type { DeviceInspection } from "../packages/protocol/recovery";

const device = { name: "test", address: "127.0.0.1:16416", adbPath: "test" };
const config = { ...defaultArknightsConfig, expectedUid: "987654321" };
function capture(page: ArknightsPage): DeviceInspection {
  return {
    address: device.address,
    foregroundPackage: "com.hypergryph.arknights",
    observedAt: new Date().toISOString(),
    image: "local",
    pageVerified: page !== "unknown",
    accountVerified: false,
    arknights: {
      page,
      pageVerified: page !== "unknown",
      accountVerified: false,
      account: "unknown",
      expectedUid: config.expectedUid,
      message: "scene",
      frames: [
        {
          page,
          anchors: [],
          ...(page === "profile" ? { uid: config.expectedUid } : {}),
        },
        {
          page,
          anchors: [],
          ...(page === "profile" ? { uid: config.expectedUid } : {}),
        },
      ],
    },
  };
}
function harness(pages: ArknightsPage[]) {
  let i = 0;
  return {
    inspect: vi.fn(async () => capture(pages[Math.min(i++, pages.length - 1)])),
    back: vi.fn(async () => {}),
    log: vi.fn(),
  };
}
it("returns shop through friends to home without any purchase port", async () => {
  const ports = harness(["credit-shop", "friends-list", "home"]);
  const result = await returnArknightsHome(
    device,
    config,
    new AbortController().signal,
    ports,
  );
  expect(result.arknights?.page).toBe("home");
  expect(ports.back).toHaveBeenCalledTimes(2);
  expect(ports.inspect).toHaveBeenCalledTimes(3);
  expect(ports.log.mock.calls.flat().join(" ")).toContain("好友列表");
});
it("home requires no input and profile can return once", async () => {
  for (const pages of [["home"], ["profile", "home"]] as ArknightsPage[][]) {
    const ports = harness(pages);
    await returnArknightsHome(
      device,
      config,
      new AbortController().signal,
      ports,
    );
    expect(ports.back).toHaveBeenCalledTimes(pages.length - 1);
  }
});
it("stops on unknown dialogs, battle, login, network and other apps", async () => {
  for (const page of [
    "unknown",
    "battle",
    "login",
    "network-error",
    "other-app",
  ] as ArknightsPage[]) {
    const ports = harness([page]);
    await expect(
      returnArknightsHome(device, config, new AbortController().signal, ports),
    ).rejects.toThrow();
    expect(ports.back).not.toHaveBeenCalled();
  }
});
it("never exceeds three returns or keeps clicking after a changed scene", async () => {
  const ports = harness(["friends-list"]);
  await expect(
    returnArknightsHome(device, config, new AbortController().signal, ports),
  ).rejects.toThrow(/3/);
  expect(ports.back).toHaveBeenCalledTimes(3);
  const changed = harness(["credit-shop", "unknown"]);
  await expect(
    returnArknightsHome(device, config, new AbortController().signal, changed),
  ).rejects.toThrow();
  expect(changed.back).toHaveBeenCalledTimes(1);
});
it("rejects stale, future, mismatched device/package/UID and inconsistent double frames before input", async () => {
  const variations: ((c: DeviceInspection) => void)[] = [
    (c) => {
      c.observedAt = "2020-01-01T00:00:00Z";
    },
    (c) => {
      c.observedAt = new Date(Date.now() + 60000).toISOString();
    },
    (c) => {
      c.address = "other";
    },
    (c) => {
      c.foregroundPackage = "other";
    },
    (c) => {
      c.recognitionError = "OCR failure";
    },
    (c) => {
      c.arknights!.expectedUid = "111111111";
    },
    (c) => {
      c.arknights!.frames[1].page = "home";
    },
    (c) => {
      c.arknights!.frames[0].uid = "111111111";
    },
  ];
  for (const vary of variations) {
    const ports = harness(["profile"]);
    ports.inspect.mockImplementation(async () => {
      const c = capture("profile");
      vary(c);
      return c;
    });
    await expect(
      returnArknightsHome(device, config, new AbortController().signal, ports),
    ).rejects.toThrow();
    expect(ports.back).not.toHaveBeenCalled();
  }
});
it("cancellation after observing prevents input", async () => {
  const controller = new AbortController(),
    ports = harness(["friends-list"]);
  ports.inspect.mockImplementation(async () => {
    controller.abort();
    return capture("friends-list");
  });
  await expect(
    returnArknightsHome(device, config, controller.signal, ports),
  ).rejects.toThrow();
  expect(ports.back).not.toHaveBeenCalled();
});
