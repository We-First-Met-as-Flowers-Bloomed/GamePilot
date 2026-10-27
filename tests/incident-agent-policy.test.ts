import { expect, it } from "vitest";
import {
  recognizeIncidentScreen,
  allowIncidentRetry,
} from "../games/agent-recovery";
import type { TaskRecord } from "../packages/protocol/task-record";
import type { Frame } from "../packages/runtime/device";
const sdkFrame = (texts: string[]): Frame => ({
  width: 1920,
  height: 1080,
  texts: texts.map((text, index) => ({
    text,
    score: 0.99,
    box: [650, 250 + index * 70, 400, 40],
  })),
});
// Original MaaCore OCR: 2026-10-09 12:29:03.360, absolute 1280x720 coordinates.
const clientUpdateFrame = (): Frame => ({
  width: 1280,
  height: 720,
  texts: [
    {
      text: "当前客户端版本已过时，请下载最新客户端",
      score: 0.942424,
      box: [395, 320, 490, 24],
    },
  ],
});
it("recognizes the recorded mandatory client update without permitting retries", () => {
  const page = recognizeIncidentScreen(clientUpdateFrame(), "arknights");
  expect(page).toBe("client-update-required");
  expect(allowIncidentRetry(task, page, 0)).toBe(false);
  expect(recognizeIncidentScreen(clientUpdateFrame(), "onmyoji")).toBe(
    "unknown",
  );
});
it.each(["complete", "partial", "low-confidence"])(
  "does not treat a %s client update prompt as a network retry",
  (kind) => {
    const frame = clientUpdateFrame();
    if (kind === "partial") frame.texts[0].text = "当前客户端版本已过时";
    if (kind === "low-confidence") frame.texts[0].score = 0.88;
    frame.texts.push({
      text: "网络连接异常",
      score: 0.99,
      box: [400, 400, 250, 24],
    });
    expect(recognizeIncidentScreen(frame, "arknights")).toBe(
      kind === "complete" ? "client-update-required" : "unknown",
    );
  },
);
it.each([
  "low-confidence",
  "invalid-score",
  "outside-dialog",
  "zero-width",
  "optional-update",
  "update-announcement",
  "unrelated-text",
  "partial",
])("does not assert mandatory client update from %s evidence", (kind) => {
  const frame = clientUpdateFrame();
  if (kind === "low-confidence") frame.texts[0].score = 0.88;
  if (kind === "invalid-score") frame.texts[0].score = Infinity;
  if (kind === "outside-dialog") frame.texts[0].box = [0, 0, 490, 24];
  if (kind === "zero-width") frame.texts[0].box[2] = 0;
  if (kind === "optional-update")
    frame.texts[0].text = "发现新版本，建议更新，暂不更新";
  if (kind === "update-announcement")
    frame.texts[0].text = "公告：当前客户端版本已过时，请下载最新客户端";
  if (kind === "unrelated-text") frame.texts[0].text = "请下载最新活动说明";
  if (kind === "partial") frame.texts[0].text = "当前客户端版本已过时";
  expect(recognizeIncidentScreen(frame, "arknights")).toBe("unknown");
});
it.each([0.6999, 0.5, 0])(
  "does not grant network retry around update text with score %s",
  (score) => {
    const frame = clientUpdateFrame();
    frame.texts[0].score = score;
    frame.texts.push({
      text: "网络连接异常",
      score: 0.99,
      box: [400, 400, 250, 24],
    });
    const page = recognizeIncidentScreen(frame, "arknights");
    expect(page).toBe("unknown");
    expect(allowIncidentRetry(task, page, 0)).toBe(false);
  },
);
it.each([
  [
    ["哔哩哔哩", "账号密码登录", "请输入账号", "请输入密码", "登录"],
    "sdk-login",
  ],
  [
    ["bilibili", "手机号登录", "请输入手机号", "获取验证码", "登录"],
    "phone-login",
  ],
  [["哔哩哔哩", "安全验证", "请输入验证码", "确认"], "verification-code"],
] as const)(
  "recognizes multi-anchor SDK identity screens as manual evidence",
  (texts, page) => {
    const frame = sdkFrame([...texts]);
    expect(recognizeIncidentScreen(frame, "arknights")).toBe(page);
    expect(recognizeIncidentScreen(frame, "onmyoji")).toBe("unknown");
    expect(allowIncidentRetry(task, page as never, 0)).toBe(false);
  },
);
it("SDK login anchors override a generic network error so identity input cannot be retried", () => {
  expect(
    recognizeIncidentScreen(
      sdkFrame(["bilibili", "账号登录", "请输入密码", "登录", "网络连接异常"]),
      "arknights",
    ),
  ).toBe("sdk-login");
});
it("partial identity form anchors keep network retry blocked when SDK classification is incomplete", () => {
  expect(
    recognizeIncidentScreen(
      sdkFrame(["账号登录", "请输入密码", "登录", "网络连接异常"]),
      "arknights",
    ),
  ).toBe("unknown");
  expect(
    recognizeIncidentScreen(
      sdkFrame(["bilibili", "请输入密码", "网络连接异常"]),
      "arknights",
    ),
  ).toBe("unknown");
});
it("does not infer an SDK identity screen from a single, weak or out-of-frame anchor", () => {
  for (const texts of [
    ["哔哩哔哩"],
    ["请输入手机号"],
    ["安全验证"],
    ["哔哩哔哩", "登录"],
  ])
    expect(recognizeIncidentScreen(sdkFrame(texts), "arknights")).toBe(
      "unknown",
    );
  const weak = sdkFrame(["哔哩哔哩", "账号登录", "请输入密码", "登录"]);
  weak.texts[0].score = 0.5;
  expect(recognizeIncidentScreen(weak, "arknights")).toBe("unknown");
  weak.texts[0].score = 0.99;
  weak.texts[0].box = [1900, 200, 400, 40];
  expect(recognizeIncidentScreen(weak, "arknights")).toBe("unknown");
});
const task = {
  gameId: "arknights",
  plan: { mode: "live", skillIds: ["login", "award"] },
  status: "failed",
  steps: [
    {
      skillId: "login",
      status: "failed",
      result: {
        arknights: {
          version: 1,
          taskType: "StartUp",
          submission: "not-submitted",
          completion: "not-started",
          observedAt: "2026-10-03T12:00:00Z",
        },
      },
    },
    { skillId: "award", status: "not-run" },
  ],
  fault: { skillId: "login", code: "skill-exception", source: "runner" },
} as TaskRecord;
it("recognizes bounded network evidence without exporting OCR text or identifiers", () => {
  const frame = {
    width: 1920,
    height: 1080,
    texts: [
      {
        text: "网络连接异常",
        score: 0.99,
        box: [600, 400, 400, 40] as [number, number, number, number],
      },
      {
        text: "UID 987654321 PRIVATE",
        score: 1,
        box: [0, 0, 300, 40] as [number, number, number, number],
      },
    ],
  };
  expect(recognizeIncidentScreen(frame)).toBe("network-error");
  frame.texts[0].score = 0.5;
  expect(recognizeIncidentScreen(frame)).toBe("unknown");
});
it("only admits known unsubmitted login failures, never resource or uncertain steps", () => {
  expect(allowIncidentRetry(task, "network-error", 0)).toBe(true);
  expect(allowIncidentRetry(task, "network-error", 2)).toBe(false);
  expect(allowIncidentRetry(task, "unknown", 0)).toBe(false);
  const missing = structuredClone(task);
  delete missing.steps[0].result;
  expect(allowIncidentRetry(missing, "network-error", 0)).toBe(false);
  expect(
    allowIncidentRetry({ ...missing, gameId: "onmyoji" }, "network-error", 0),
  ).toBe(false);
  for (const skillId of ["fight", "mall", "foster"])
    expect(
      allowIncidentRetry(
        { ...task, fault: { ...task.fault!, skillId } },
        "network-error",
        0,
      ),
    ).toBe(false);
  expect(
    allowIncidentRetry({ ...task, status: "cancelled" }, "network-error", 0),
  ).toBe(false);
  const submitted = structuredClone(task);
  submitted.steps[0].result = {
    arknights: { submission: "submitted" },
  } as never;
  expect(allowIncidentRetry(submitted, "network-error", 0)).toBe(false);
});
