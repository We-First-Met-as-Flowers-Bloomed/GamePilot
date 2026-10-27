function cliLaneCandidates(lanes, argument, game) {
  if (game && !["arknights", "onmyoji"].includes(game))
    throw new Error("未知游戏 " + game);
  const aliases = { a: 0, b: 1, 0: 0, 1: 1 };
  const instance = Object.hasOwn(aliases, argument)
    ? aliases[argument]
    : undefined;
  return lanes.filter((item) => {
    if (game && item[game]?.enabled !== true) return false;
    if (instance === undefined) {
      const ids = [argument, `lane-${argument}`];
      return ids.includes(item.id) || (game && ids.includes(item.legacyBinding?.laneId));
    }
    let originalInstance = item.instance;
    if (game && item.legacyBinding) {
      const binding = item.legacyBinding;
      if (binding.scope !== undefined) {
        let scope;
        try { scope = JSON.parse(binding.scope); } catch { /* Reject below. */ }
        if (!Array.isArray(scope) || !Number.isSafeInteger(scope[1]) || scope[1] < 0)
          throw new Error("历史槽位映射无效：" + item.id);
        originalInstance = scope[1];
      } else if (["lane-a", "lane-b"].includes(binding.laneId)) {
        originalInstance = binding.laneId === "lane-a" ? 0 : 1;
      }
    }
    return originalInstance === instance;
  });
}
export function selectCliLane(lanes, argument, game) {
  const candidates = cliLaneCandidates(lanes, argument, game);
  if (!candidates.length) throw new Error("找不到指定槽位 " + argument);
  if (candidates.length !== 1)
    throw new Error("槽位目标不唯一，有歧义：" + argument);
  addressForLane(candidates[0], game);
  return candidates[0];
}
export function selectCliCombos(lanes, argument = "all", game = "all") {
  if (!["all", "arknights", "onmyoji"].includes(game))
    throw new Error("未知游戏 " + game);
  const result = [];
  for (const targetGame of ["onmyoji", "arknights"]) {
    if (game !== "all" && game !== targetGame) continue;
    const candidates = argument === "all"
      ? lanes.filter(lane => lane[targetGame]?.enabled === true)
      : cliLaneCandidates(lanes, argument, targetGame);
    if (argument !== "all" && candidates.length > 1)
      throw new Error("槽位目标不唯一，有歧义：" + argument);
    for (const lane of candidates) {
      if (lane.enabled === false) continue;
      addressForLane(lane, targetGame);
      result.push({ lane: lane.id, game: targetGame });
    }
  }
  return result;
}
export function assertCliOptions(args, values, flags) {
  const valueFlags = new Set(values.map((name) => "--" + name));
  const plainFlags = new Set(flags.map((name) => "--" + name));
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (seen.has(flag)) throw new Error("参数重复：" + flag);
    seen.add(flag);
    if (plainFlags.has(flag)) continue;
    if (!valueFlags.has(flag)) throw new Error("未知参数：" + flag);
    const value = args[++index];
    if (!value || value.startsWith("--"))
      throw new Error("参数缺少值：" + flag);
  }
}
export function addressForLane(lane, game) {
  const override = game ? lane.deviceInstances?.[game] : undefined;
  const instance = Number.isSafeInteger(override) ? override : lane.instance;
  const port = 16384 + 32 * instance;
  if (!Number.isSafeInteger(instance) || instance < 0 || port > 65535) {
    throw new Error("槽位实例号无效，拒绝回退到实例 0");
  }
  return "127.0.0.1:" + port;
}
export function selectCliDevice(devices, address) {
  const matches = devices.filter((item) => item.address === address);
  if (!address || !matches.length) throw new Error("未发现指定设备 " + address);
  if (matches.length !== 1)
    throw new Error("设备地址不唯一，有歧义：" + address);
  return matches[0];
}
export function parseSurveyArgs(args) {
  const options = {
    lane: "a",
    label: "survey",
    taps: [],
    waitMs: 1500,
    ocr: "0.7",
    launch: false,
  };
  const values = new Set(["--lane", "--label", "--tap", "--wait", "--ocr"]);
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag !== "--tap" && seen.has(flag))
      throw new Error("参数重复：" + flag);
    seen.add(flag);
    if (flag === "--launch") {
      options.launch = true;
      continue;
    }
    if (!values.has(flag)) throw new Error("未知参数：" + flag);
    const value = args[++index];
    if (!value || value.startsWith("--"))
      throw new Error("参数缺少值：" + flag);
    if (flag === "--lane") options.lane = value;
    if (flag === "--label") options.label = value;
    if (flag === "--ocr") {
      if (
        !Number.isFinite(Number(value)) ||
        Number(value) < 0 ||
        Number(value) > 1
      ) {
        throw new Error("OCR 阈值必须在 0 到 1 之间");
      }
      options.ocr = value;
    }
    if (flag === "--wait") {
      const milliseconds = Number(value) * 1000;
      if (!Number.isFinite(milliseconds) || milliseconds < 0) {
        throw new Error("等待秒数必须为非负有限数值");
      }
      options.waitMs = milliseconds;
    }
    if (flag === "--tap") {
      const pair = value.split(",");
      const [x, y] = pair.map(Number);
      if (
        pair.length !== 2 ||
        pair.some((item) => !item.trim()) ||
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        x < 0 ||
        x >= 1920 ||
        y < 0 ||
        y >= 1080
      ) {
        throw new Error("点击坐标必须是 1920×1080 范围内的 x,y");
      }
      options.taps.push([x, y]);
    }
  }
  return options;
}
