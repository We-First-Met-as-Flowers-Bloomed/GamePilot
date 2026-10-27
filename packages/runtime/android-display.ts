export interface AndroidDisplay {
  logicalId: number;
  physicalId: string;
  foregroundPackage?: string;
  width?: number;
  height?: number;
}

interface Viewport {
  logicalId: number;
  uniqueId: string;
  valid: boolean;
  active: boolean;
  body: string;
}

function fail(message: string): never {
  throw new Error("Android display: " + message);
}

function logicalId(value: string, label: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value)) fail("invalid " + label);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail("invalid " + label);
  return parsed;
}

function field(body: string, name: string): string | undefined {
  const matches = [
    ...body.matchAll(
      new RegExp(
        "\\b" +
          name +
          "\\s*=\\s*('[^']*'|\"[^\"]*\"|Rect\\([^)]*\\)|[^,}\\r\\n]*)",
        "g",
      ),
    ),
  ];
  if (matches.length > 1) fail("ambiguous viewport " + name);
  const raw = matches[0]?.[1].trim();
  if (raw?.startsWith("'") || raw?.startsWith('"')) {
    if (raw.length < 2 || raw.at(-1) !== raw[0]) {
      fail("invalid quoted viewport " + name);
    }
    return raw.slice(1, -1);
  }
  return raw;
}

function viewports(displays: string): Viewport[] {
  const snapshots = [
    ...displays.matchAll(/^[ \t]*mViewports\s*=\s*\[([\s\S]*?)\]/gm),
  ];
  if (snapshots.length !== 1) fail("missing or ambiguous viewport snapshot");
  const body = snapshots[0][1];
  const entries = [...body.matchAll(/DisplayViewport\s*\{([^{}]*)\}/g)];
  if (
    !entries.length ||
    body.replace(/DisplayViewport\s*\{[^{}]*\}/g, "").replace(/[,\s]/g, "")
  ) {
    fail("incomplete viewport snapshot");
  }
  const result: Viewport[] = [];
  const ids = new Set<number>();
  const physicalIds = new Set<string>();
  for (const entry of entries) {
    const text = entry[1];
    const id = field(text, "displayId");
    if (id === undefined) fail("missing viewport displayId");
    const parsedId = logicalId(id, "viewport displayId");
    if (ids.has(parsedId)) fail("duplicate logical display mapping");
    ids.add(parsedId);
    const uniqueId = field(text, "uniqueId");
    if (!uniqueId) fail("missing viewport uniqueId");
    if (/^local:(0|[1-9]\d*)$/.test(uniqueId)) {
      if (physicalIds.has(uniqueId)) fail("duplicate physical display mapping");
      physicalIds.add(uniqueId);
    }
    result.push({
      logicalId: parsedId,
      uniqueId,
      valid: field(text, "valid") === "true",
      active: field(text, "isActive") === "true",
      body: text,
    });
  }
  return result;
}

function focusedDisplay(windows: string, viewportList: Viewport[]) {
  const top = [
    ...windows.matchAll(/^[ \t]*mTopFocusedDisplayId\s*=\s*([^\r\n]+)/gm),
  ];
  if (top.length > 1) fail("focused display is ambiguous");
  const markers = [
    ...windows.matchAll(
      /^[ \t]*Display:\s*mDisplayId\s*=\s*(\d+)\b[^\r\n]*|^WINDOW MANAGER\b[^\r\n]*/gm,
    ),
  ];
  const blocks = new Map<number, string>();
  for (let index = 0; index < markers.length; index++) {
    const marker = markers[index];
    if (marker[1] === undefined) continue;
    const id = logicalId(marker[1], "window displayId");
    if (blocks.has(id)) fail("duplicate window display block");
    blocks.set(
      id,
      windows.slice(
        marker.index! + marker[0].length,
        markers[index + 1]?.index ?? windows.length,
      ),
    );
  }
  let id: number;
  if (top.length) {
    id = logicalId(top[0][1].trim(), "focused displayId");
  } else {
    // Older dumps omit mTopFocusedDisplayId. Only a single explicit mapping
    // permits a global focus; a lone focus on a multi-display device is unsafe.
    if (viewportList.length !== 1 || blocks.size > 1) {
      fail("focused display is ambiguous without mTopFocusedDisplayId");
    }
    id = viewportList[0].logicalId;
  }
  let body = blocks.get(id);
  if (body === undefined) {
    if (
      blocks.size ||
      viewportList.length !== 1 ||
      viewportList[0].logicalId !== id
    ) {
      fail("focused display has no matching window block");
    }
    body = windows;
  }
  const focus = [...body.matchAll(/^[ \t]*mCurrentFocus\s*=\s*([^\r\n]+)/gm)];
  if (focus.length > 1) fail("current focus is ambiguous");
  if (focus.length !== 1 || !/^Window\{[^{}]+\}$/.test(focus[0][1].trim())) {
    fail("current focus is unavailable on the focused display");
  }
  const foregroundPackage = focus[0][1].match(
    /\bu\d+\s+([A-Za-z][A-Za-z0-9_.]*)\//,
  )?.[1];
  return { id, foregroundPackage };
}

function dimensions(body: string): Pick<AndroidDisplay, "width" | "height"> {
  const frame = field(body, "logicalFrame");
  let width: number;
  let height: number;
  if (frame !== undefined) {
    const rect = frame.match(
      /^Rect\((-?\d+),\s*(-?\d+)\s*-\s*(-?\d+),\s*(-?\d+)\)$/,
    );
    if (!rect) fail("invalid viewport dimensions");
    const [left, top, right, bottom] = rect.slice(1).map(Number);
    if (![left, top, right, bottom].every(Number.isSafeInteger)) {
      fail("invalid viewport dimensions");
    }
    width = right - left;
    height = bottom - top;
  } else {
    const w = field(body, "deviceWidth");
    const h = field(body, "deviceHeight");
    if (w === undefined && h === undefined) return {};
    if (!w || !h || !/^\d+$/.test(w) || !/^\d+$/.test(h)) {
      fail("incomplete viewport dimensions");
    }
    width = Number(w);
    height = Number(h);
  }
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    fail("invalid viewport dimensions");
  }
  return { width, height };
}

/**
 * 每个**逻辑显示**上的前台包名（`dumpsys window displays` 里的 `Display: mDisplayId=N` 块）。
 *
 * 为什么需要它（2026-10-16 实测）：MuMu 15 会把不同 App 放到不同的 `mumuscreenNNN` 显示上，
 * 而这些显示上的 `mCurrentFocus` 是 **null**（焦点只属于窗口所在的那一块），
 * 于是"聚焦显示"解析出来是桌面、前台包名对不上，方舟的登录核验永远失败。
 * 但每个显示的 `mFocusedApp` 是可靠的：display 2 → 阴阳师、display 3 → 方舟、display 0 → 桌面。
 *
 * 纯解析、不改任何行为；单显示设备上返回一个条目，与旧路径等价。
 */
export function foregroundPackagesByDisplay(windows: string): Map<number, string> {
  const result = new Map<number, string>();
  const markers = [
    ...windows.matchAll(/^[ \t]*Display:\s*mDisplayId\s*=\s*(\d+)\b[^\r\n]*/gm),
  ];
  for (let index = 0; index < markers.length; index++) {
    const marker = markers[index];
    const id = Number(marker[1]);
    if (!Number.isSafeInteger(id)) continue;
    const body = windows.slice(
      marker.index! + marker[0].length,
      markers[index + 1]?.index ?? windows.length,
    );
    const focused = [
      ...body.matchAll(/^[ \t]*mFocusedApp\s*=\s*[^\r\n]*?\bu\d+\s+([A-Za-z][\w.]*)\//gm),
    ];
    if (focused.length !== 1) continue;
    result.set(id, focused[0][1]);
  }
  return result;
}

/** 列出 `dumpsys display` 里的全部视口（逻辑 id → 物理抓屏 id）。 */
export function listAndroidDisplays(
  displays: string,
): { logicalId: number; physicalId: string; width?: number; height?: number }[] {
  const result: { logicalId: number; physicalId: string; width?: number; height?: number }[] =
    [];
  for (const viewport of viewports(displays)) {
    const physicalId = viewport.uniqueId.match(/^local:((?:0|[1-9]\d*))$/)?.[1];
    if (!physicalId) continue;
    result.push({
      logicalId: viewport.logicalId,
      physicalId,
      ...dimensions(viewport.body),
    });
  }
  return result;
}

/** Resolves one foreground logical display to an exact physical screencap ID. */export function resolveAndroidDisplay(
  windows: string,
  displays: string,
  surfaceFlinger?: string,
): AndroidDisplay {
  const viewportList = viewports(displays);
  const focused = focusedDisplay(windows, viewportList);
  const selected = viewportList.find(
    (viewport) => viewport.logicalId === focused.id,
  );
  if (!selected) fail("focused display has no viewport mapping");
  if (!selected.valid || !selected.active)
    fail("focused viewport must be valid and active");
  const physicalId = selected.uniqueId.match(/^local:((?:0|[1-9]\d*))$/)?.[1];
  if (!physicalId)
    fail("focused viewport uniqueId must identify a local physical display");
  if (surfaceFlinger !== undefined) {
    const matches = [
      ...surfaceFlinger.matchAll(
        /^[ \t]*Display\s+(\d+)\s+\(HWC display\s+(\d+)\):[^\r\n]*/gm,
      ),
    ];
    const ids = matches.map((match) => match[1]);
    const hwcIds = matches.map((match) => match[2]);
    if (
      new Set(ids).size !== ids.length ||
      new Set(hwcIds).size !== hwcIds.length
    )
      fail("duplicate SurfaceFlinger physical display");
    if (!ids.includes(physicalId))
      fail("physical display is missing from SurfaceFlinger");
  }
  return {
    logicalId: focused.id,
    physicalId,
    ...(focused.foregroundPackage
      ? { foregroundPackage: focused.foregroundPackage }
      : {}),
    ...dimensions(selected.body),
  };
}
