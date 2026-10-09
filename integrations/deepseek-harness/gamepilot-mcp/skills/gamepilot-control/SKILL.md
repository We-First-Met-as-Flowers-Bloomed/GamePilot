---
name: gamepilot-control
description: 通过 GamePilot 的八个 MCP 工具查询状态、预览和确认保存的游戏日常、核对回执、停止或续跑原请求。用户要求 Harness 控制运行中的 GamePilot、阴阳师或明日方舟日常时使用。
---

# GamePilot 本机控制

使用已注册的 `mcp__gamepilot__gamepilot_*` 工具连接运行中的 GamePilot App。宿主负责设备执行、身份核验、历史、资源租约与调度。不要改走 shell、ADB、坐标点击或内部执行器，不增加与 App 竞争的定时器。

## 查询与当前会话

调用 `mcp__gamepilot__gamepilot_status({})` 和 `mcp__gamepilot__gamepilot_capabilities({})`，以真实回执为准。

需要会话的调用只使用 status 返回的 `selectedSessionId`，并验证它匹配 `chatSessions` 中一项的 `id`。缺失、无匹配或会话切换时停止执行流程，请用户在 App 选中目标会话后重新读取 status。禁止猜第一项或使用 fallback。GamePilot 0.14.36 不返回此字段，需升级到 0.14.37 或更新的兼容版本。

## 保存日常：预览、确认、结果

1. 用 `mcp__gamepilot__gamepilot_command_review` 传 `{sessionId, text}`。保存日常的 text 只支持“运行保存的日常”“运行每日任务”“运行双游戏日常”“/run-daily”；不添加 `laneId`、`gameId`、`skillIds` 或其他 schema 外参数。
2. 展示宿主返回的真实 `summary`、`reviewId`、`revision` 与部分执行要求。只有用户已明确授权执行该预览的范围，才调用 `mcp__gamepilot__gamepilot_command_confirm`，传宿主回执中的 `{sessionId, reviewId, revision}`；沿用已有有效授权，不重复索取。预览变化或过期时重新核对授权范围。
3. `needsAcknowledgement:true` 时，先核对现场与剩余步骤，再按用户明确授权传 `acknowledgePartial:true`。它不能绕过同日已完成拒绝、重跑已完成业务、重购或重发未知原生提交。
4. 确认返回 `submitted` 仅代表受理。对宿主返回的每个真实 `requestId` 调用 `mcp__gamepilot__gamepilot_events`，传 `{afterSeq:0, limit:100, requestId}`。后续将返回的 `cursor` 作为 `afterSeq`，直到 `hasMore:false`；若 `hasMore:true` 而 cursor 不前进，停止并核对 App。没有新事件时只说明尚无新回执。
5. 只有原请求的宿主终态和 App 账本支持时才报告完成；能力说明、模型文字、受理回执不算完成。`gap`、`error`、超时或未知结果必须说明未核实，在 App 核对；不能自动重发确认或新建请求重跑。

## 停止与续跑

停止仅使用明确绑定原请求的 `mcp__gamepilot__gamepilot_stop({sessionId, requestId})`，随后读该请求 events 核对终态。取消等待不会停止游戏。

续跑只使用 `mcp__gamepilot__gamepilot_resume_review({sessionId, requestId})` 预览原请求剩余任务；核对并取得对应明确授权后，使用其返回的 `reviewId`、`revision` 调用 `mcp__gamepilot__gamepilot_resume_confirm`。部分确认与未知提交遵守上述宿主门禁，不创建替代请求绕过拒绝。

未发现这八个工具时报告连接或插件未就绪；不虚构调用和结果，不把内部 `read_skill`、`compile_plan`、`get_run` 当成已注册 MCP 工具。
