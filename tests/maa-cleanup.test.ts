import { afterEach, describe, expect, it, vi } from "vitest";

// The worker's native side-effect import must never load during unit tests.
vi.mock("@maaxyz/maa-node", () => ({}));
vi.mock("node:fs/promises", () => ({ access: vi.fn(async () => {}) }));
import { MaaEngine } from "../packages/runtime/maa";

describe("temporary recognition tasker ownership", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("announces a screencap before native submission and keeps it pending until the native wait settles", async () => {
    const events: unknown[] = [];
    let finish!: (value: unknown) => void;
    const native = new Promise((resolve) => {
      finish = resolve;
    });
    const engine = new MaaEngine((event) => events.push(event));
    Object.assign(engine, {
      controller: {
        connected: true,
        post_screencap: () => {
          expect(events).toEqual([
            expect.objectContaining({ operation: "screencap", phase: "begin" }),
          ]);
          return { wait: () => native };
        },
      },
    });
    const capture = engine.capture();
    await Promise.resolve();
    expect(events).toHaveLength(1);
    finish({ succeeded: true, get: () => new Uint8Array([1]) });
    await capture;
    expect(events).toEqual([
      expect.objectContaining({ operation: "screencap", phase: "begin" }),
      expect.objectContaining({ operation: "screencap", phase: "end" }),
    ]);
    expect((events[0] as { id: string }).id).toBe(
      (events[1] as { id: string }).id,
    );
  });
  it.each(["observe", "matchTemplate", "matchFeatures", "colorSlots"] as const)(
    "%s does not abandon a pending native screencap or start another native action on cancellation",
    async (method) => {
      const events: { operation: string; phase: string }[] = [];
      let finish!: (value: unknown) => void;
      const native = new Promise((resolve) => {
        finish = resolve;
      });
      const destroy = vi.fn(),
        recognize = vi.fn();
      vi.stubGlobal("maa", {
        Tasker: class {
          destroy = destroy;
          post_recognition = recognize;
        },
      });
      const engine = new MaaEngine((event) => events.push(event));
      Object.assign(engine, {
        resource: {},
        tasker: { post_recognition: recognize },
        controller: {
          connected: true,
          post_screencap: () => {
            expect(events).toEqual([
              expect.objectContaining({
                operation: "screencap",
                phase: "begin",
              }),
            ]);
            return { wait: () => native };
          },
        },
      });
      const abort = new AbortController();
      const operation =
        method === "observe"
          ? engine.observe(abort.signal)
          : method === "colorSlots"
            ? engine.colorSlots(
                [[0, 0, 10, 10]],
                [0, 0, 0],
                [255, 255, 255],
                1,
                abort.signal,
              )
            : method === "matchTemplate"
              ? engine.matchTemplate(
                  "fixture.png",
                  [0, 0, 10, 10],
                  0.8,
                  abort.signal,
                )
              : engine.matchFeatures(
                  "fixture.png",
                  [0, 0, 10, 10],
                  abort.signal,
                );
      const result = operation.catch((error) => error);
      await Promise.resolve();
      await Promise.resolve();
      expect(events).toHaveLength(1);
      abort.abort();
      await Promise.resolve();
      expect(destroy).not.toHaveBeenCalled();
      expect(recognize).not.toHaveBeenCalled();
      expect(events).toHaveLength(1);
      finish({ succeeded: false, get: () => null });
      expect(await result).toBeInstanceOf(Error);
      expect(events.at(-1)).toMatchObject({
        operation: "screencap",
        phase: "end",
      });
      expect(recognize).not.toHaveBeenCalled();
      if (method !== "observe") expect(destroy).toHaveBeenCalledOnce();
    },
  );
  it.each(["failed-job", "disconnected", "native-exception"])(
    "classifies confirmed connect failures and destroys controller: %s",
    async (failure) => {
      const destroy = vi.fn();
      vi.stubGlobal("maa", {
        AdbScreencapMethod: { Default: 0 },
        AdbInputMethod: { Default: 0 },
        AdbController: class {
          connected = failure !== "disconnected";
          destroy = destroy;
          post_connection() {
            return {
              wait: async () => {
                if (failure === "native-exception")
                  throw new Error("native exception");
                return { succeeded: failure !== "failed-job" };
              },
            };
          }
        },
      });
      const error = await new MaaEngine()
        .connect({ name: "fake", adbPath: "fake-adb", address: "fake-address" })
        .catch((error) => error);
      expect(error).toBeInstanceOf(Error);
      expect(error.code).toBe(
        failure === "native-exception" ? undefined : "connection-unavailable",
      );
      expect(destroy).toHaveBeenCalledOnce();
    },
  );
  for (const operation of [
    "matchTemplate",
    "matchFeatures",
    "colorSlots",
  ] as const) {
    it.each([
      "screenshot-failed",
      "screenshot-rejected",
      "cancelled",
      "resource-binding",
      "controller-binding",
      "recognition-rejected",
      "success",
    ])(`${operation} destroys its tasker on %s`, async (failure) => {
      const abort = new AbortController();
      const destroy = vi.fn();
      const recognition = vi.fn(() => ({
        wait: async () => {
          if (failure === "recognition-rejected")
            throw new Error("recognition failed");
          return { succeeded: true, get: () => ({ nodes: [] }) };
        },
      }));
      const created = vi.fn();
      vi.stubGlobal("maa", {
        Tasker: class {
          constructor() {
            created();
          }
          set resource(_: unknown) {
            if (failure === "resource-binding")
              throw new Error("resource binding failed");
          }
          set controller(_: unknown) {
            if (failure === "controller-binding")
              throw new Error("controller binding failed");
          }
          destroy = destroy;
          post_recognition = recognition;
        },
      });
      const engine = new MaaEngine();
      // Inject only the external native boundary; run the actual recognition method.
      Object.assign(engine, {
        resource: {},
        tasker: {},
        controller: {
          connected: true,
          post_screencap: () => ({
            wait: async () => {
              if (failure === "screenshot-rejected")
                throw new Error("screenshot failed");
              if (failure === "cancelled") abort.abort(new Error("cancelled"));
              return {
                succeeded: failure !== "screenshot-failed",
                get: () =>
                  failure === "screenshot-failed" ? null : new Uint8Array([1]),
              };
            },
          }),
        },
      });
      const run =
        operation === "colorSlots"
          ? engine.colorSlots(
              [[0, 0, 10, 10]],
              [0, 0, 0],
              [255, 255, 255],
              1,
              abort.signal,
            )
          : operation === "matchTemplate"
            ? engine.matchTemplate(
                "fixture.png",
                [0, 0, 10, 10],
                0.8,
                abort.signal,
              )
            : engine.matchFeatures("fixture.png", [0, 0, 10, 10], abort.signal);
      if (failure === "success")
        await expect(run).resolves.toEqual(
          operation === "colorSlots" ? [false] : null,
        );
      else await expect(run).rejects.toThrow();
      expect(created).toHaveBeenCalledOnce();
      expect(destroy).toHaveBeenCalledOnce();
      if (failure === "cancelled") expect(recognition).not.toHaveBeenCalled();
    });
  }
});
