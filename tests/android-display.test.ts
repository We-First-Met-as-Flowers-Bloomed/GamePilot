import { describe, expect, it } from "vitest";
import { resolveAndroidDisplay } from "../packages/runtime/android-display";

// Minimal anonymized excerpts from capture-diagnosis/lane-{a,b}-{window,display,
// surfaceflinger}.stdout.txt (2026-10-16). Logical display 2 is HWC display 1.
const desktop = "4619827820427265280";
const game = "4619827767814508545";
const extra = "4619826888814064386";
const windows = [
  "WINDOW MANAGER DISPLAY CONTENTS (dumpsys window displays)",
  "  Display: mDisplayId=3 (organized)",
  "  mCurrentFocus=null",
  "  Display: mDisplayId=0 (organized)",
  "  mCurrentFocus=Window{aaa u0 app.example.launcher/.Launcher}",
  "  Display: mDisplayId=2 (organized)",
  "  mCurrentFocus=Window{bbb u0 com.example.game/.Client}",
  "WINDOW MANAGER WINDOWS (dumpsys window windows)",
  "  mTopFocusedDisplayId=2",
].join("\n");
const viewport = (id: number, physical: string) =>
  "DisplayViewport{type=INTERNAL, valid=true, isActive=true, displayId=" +
  id +
  ", uniqueId='local:" +
  physical +
  "', logicalFrame=Rect(0, 0 - 1280, 720), deviceWidth=1280, deviceHeight=720}";
const displays =
  "mViewports=[" +
  [viewport(0, desktop), viewport(2, game), viewport(3, extra)].join(", ") +
  "]";
const sfDisplay = (physical: string, hwc: number) =>
  "Display " + physical + " (HWC display " + hwc + "): port=" + hwc;
const surfaceFlinger = [
  sfDisplay(desktop, 0),
  sfDisplay(game, 1),
  sfDisplay(extra, 2),
].join("\n");
const singleWindows = [
  "  Display: mDisplayId=7 (organized)",
  "  mCurrentFocus=Window{ccc u0 com.example.game/.Client}",
].join("\n");
const singleDisplay = "mViewports=[" + viewport(7, game) + "]";

describe("Android foreground display resolution", () => {
  it("uses the focused display's own focus and preserves the 64-bit physical ID", () => {
    expect(resolveAndroidDisplay(windows, displays, surfaceFlinger)).toEqual({
      logicalId: 2,
      physicalId: game,
      foregroundPackage: "com.example.game",
      width: 1280,
      height: 720,
    });
  });

  it("resolves the lane-b desktop when display 0 actually has the top focus", () => {
    expect(
      resolveAndroidDisplay(
        windows.replace("mTopFocusedDisplayId=2", "mTopFocusedDisplayId=0"),
        displays,
        surfaceFlinger,
      ),
    ).toMatchObject({
      logicalId: 0,
      physicalId: desktop,
      foregroundPackage: "app.example.launcher",
    });
  });

  it("follows changed topology instead of caching the token or list order", () => {
    const changed = "18446744073709551614";
    expect(
      resolveAndroidDisplay(
        windows
          .replaceAll("mDisplayId=2", "mDisplayId=9")
          .replace("mTopFocusedDisplayId=2", "mTopFocusedDisplayId=9"),
        "mViewports=[" +
          viewport(9, changed) +
          ", " +
          viewport(0, desktop) +
          "]",
        sfDisplay(changed, 4) + "\n" + sfDisplay(desktop, 0),
      ),
    ).toMatchObject({ logicalId: 9, physicalId: changed });
  });

  it("allows an omitted SurfaceFlinger dump while requiring the viewport mapping", () => {
    expect(resolveAndroidDisplay(windows, displays).physicalId).toBe(game);
  });

  it("supports a legacy single display with an explicit local mapping", () => {
    expect(resolveAndroidDisplay(singleWindows, singleDisplay)).toMatchObject({
      logicalId: 7,
      physicalId: game,
    });
  });

  it("supports a unique legacy global focus without inventing display 0", () => {
    expect(
      resolveAndroidDisplay(
        "mCurrentFocus=Window{ccc u0 com.example.game/.Client}",
        singleDisplay,
      ),
    ).toMatchObject({ logicalId: 7, physicalId: game });
  });

  it("does not use global focus to select one of multiple display mappings", () => {
    expect(() =>
      resolveAndroidDisplay(
        "mCurrentFocus=Window{ccc u0 com.example.game/.Client}",
        displays,
      ),
    ).toThrow(/Android display:.*ambiguous/i);
  });

  it("rejects a missing focused display block even when another display has focus", () => {
    expect(() =>
      resolveAndroidDisplay(
        windows.replace("mTopFocusedDisplayId=2", "mTopFocusedDisplayId=8"),
        displays,
      ),
    ).toThrow(/Android display:.*focused display/i);
  });

  it.each([
    "mCurrentFocus=null",
    "mFocusedApp=ActivityRecord{bbb u0 com.example.game/.Client}",
  ])("rejects an unavailable focus on the selected display: %s", (focus) => {
    expect(() =>
      resolveAndroidDisplay(
        windows.replace(
          "mCurrentFocus=Window{bbb u0 com.example.game/.Client}",
          focus,
        ),
        displays,
      ),
    ).toThrow(/Android display:.*focus/i);
  });

  it("does not borrow global focus from the next window manager section", () => {
    expect(() =>
      resolveAndroidDisplay(
        windows
          .replace("mCurrentFocus=Window{bbb u0 com.example.game/.Client}", "")
          .replace(
            "mTopFocusedDisplayId=2",
            "mCurrentFocus=Window{ccc u0 wrong.app/.Wrong}\n  mTopFocusedDisplayId=2",
          ),
        displays,
      ),
    ).toThrow(/Android display:.*focus/i);
  });

  it("rejects absent viewports instead of guessing from an unrelated local ID", () => {
    expect(() =>
      resolveAndroidDisplay(windows, "mUniqueDisplayId=local:" + game),
    ).toThrow(/Android display:.*viewport/i);
  });

  it.each(["valid=false", "isActive=false", "isActive=unknown"])(
    "rejects a viewport that is not explicitly valid and active: %s",
    (field) => {
      const key = field.split("=")[0];
      const target = viewport(2, game).replace(key + "=true", field);
      expect(() =>
        resolveAndroidDisplay(
          windows,
          "mViewports=[" + viewport(0, desktop) + ", " + target + "]",
        ),
      ).toThrow(/Android display:.*valid.*active/i);
    },
  );

  it("rejects virtual unique IDs that cannot route physical screencap", () => {
    expect(() =>
      resolveAndroidDisplay(
        windows,
        displays.replace("local:" + game, "virtual:example,42"),
      ),
    ).toThrow(/Android display:.*local/i);
  });

  it("rejects duplicate logical mappings rather than selecting the first one", () => {
    expect(() =>
      resolveAndroidDisplay(
        windows,
        "mViewports=[" + viewport(2, game) + ", " + viewport(2, extra) + "]",
      ),
    ).toThrow(/Android display:.*duplicate.*logical/i);
  });

  it("rejects one physical display assigned to different logical displays", () => {
    expect(() =>
      resolveAndroidDisplay(
        windows,
        "mViewports=[" + viewport(0, game) + ", " + viewport(2, game) + "]",
      ),
    ).toThrow(/Android display:.*duplicate.*physical/i);
  });

  it("rejects conflicting focused-display IDs", () => {
    expect(() =>
      resolveAndroidDisplay(windows + "\nmTopFocusedDisplayId=0", displays),
    ).toThrow(/Android display:.*focused.*ambiguous/i);
  });

  it("rejects duplicate focused display blocks", () => {
    expect(() =>
      resolveAndroidDisplay(
        singleWindows + "\n" + singleWindows,
        singleDisplay,
      ),
    ).toThrow(/Android display:.*duplicate.*display/i);
  });

  it("rejects a supplied SurfaceFlinger snapshot without the selected physical ID", () => {
    expect(() =>
      resolveAndroidDisplay(windows, displays, sfDisplay(desktop, 0)),
    ).toThrow(/Android display:.*SurfaceFlinger/i);
  });

  it("rejects duplicate SurfaceFlinger physical IDs", () => {
    expect(() =>
      resolveAndroidDisplay(
        windows,
        displays,
        surfaceFlinger + "\n" + sfDisplay(game, 7),
      ),
    ).toThrow(/Android display:.*duplicate.*SurfaceFlinger/i);
  });

  it("rejects conflicting SurfaceFlinger IDs for the same HWC display", () => {
    expect(() =>
      resolveAndroidDisplay(
        windows,
        displays,
        sfDisplay(desktop, 0) + "\n" + sfDisplay(game, 0),
      ),
    ).toThrow(/Android display:.*duplicate.*SurfaceFlinger/i);
  });

  it("rejects an empty SurfaceFlinger snapshot when one was supplied", () => {
    expect(() => resolveAndroidDisplay(windows, displays, "")).toThrow(
      /Android display:.*SurfaceFlinger/i,
    );
  });

  it("rejects a missing physical unique ID", () => {
    expect(() =>
      resolveAndroidDisplay(
        singleWindows,
        singleDisplay.replace("uniqueId='local:" + game + "', ", ""),
      ),
    ).toThrow(/Android display:.*uniqueId/i);
  });

  it.each(["'local:" + game, '"local:' + game + "'"])(
    "rejects an unterminated or mismatched quoted unique ID: %s",
    (uniqueId) => {
      expect(() =>
        resolveAndroidDisplay(
          singleWindows,
          singleDisplay.replace("'local:" + game + "'", uniqueId),
        ),
      ).toThrow(/Android display:.*uniqueId/i);
    },
  );

  it("omits dimensions when the selected viewport does not provide them", () => {
    expect(
      resolveAndroidDisplay(
        singleWindows,
        singleDisplay.replace(
          ", logicalFrame=Rect(0, 0 - 1280, 720), deviceWidth=1280, deviceHeight=720",
          "",
        ),
      ),
    ).toEqual({
      logicalId: 7,
      physicalId: game,
      foregroundPackage: "com.example.game",
    });
  });

  it("uses the logical frame rather than physical device orientation", () => {
    expect(
      resolveAndroidDisplay(
        singleWindows,
        singleDisplay.replace(
          "logicalFrame=Rect(0, 0 - 1280, 720), deviceWidth=1280, deviceHeight=720",
          "logicalFrame=Rect(10, 20 - 1290, 740), deviceWidth=720, deviceHeight=1280",
        ),
      ),
    ).toMatchObject({ width: 1280, height: 720 });
  });

  it("rejects an invalid logical frame", () => {
    expect(() =>
      resolveAndroidDisplay(
        singleWindows,
        singleDisplay.replace("0, 0 - 1280, 720", "0, 0 - 0, 720"),
      ),
    ).toThrow(/Android display:.*dimensions/i);
  });

  it("leaves package absent for a focused system window without a component", () => {
    expect(
      resolveAndroidDisplay(
        singleWindows.replace("com.example.game/.Client", "NotificationShade"),
        singleDisplay,
      ),
    ).toEqual({ logicalId: 7, physicalId: game, width: 1280, height: 720 });
  });

  it("rejects duplicate focus entries inside the selected block", () => {
    expect(() =>
      resolveAndroidDisplay(
        singleWindows + "\nmCurrentFocus=Window{ddd u0 wrong.app/.Wrong}",
        singleDisplay,
      ),
    ).toThrow(/Android display:.*focus.*ambiguous/i);
  });

  it("rejects missing focus and viewport data instead of defaulting to 0", () => {
    expect(() => resolveAndroidDisplay("", "")).toThrow(/Android display:/);
  });
});
