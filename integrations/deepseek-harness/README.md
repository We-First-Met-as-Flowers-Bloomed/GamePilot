# Official DeepSeek Harness → GamePilot

本适配沿用官方Harness的配置型MCP bundle和GamePilot既有本机控制接口，不包含另一套游戏执行器，不修改官方安装包。

本机核对版本：Harness `0.2.0-rc.2`，初测GamePilot `0.14.36`，接入修复版 `0.14.37`，Node `22.18.0`。目录名`dsh_latest`本身不是版本证据。

## 安装

1. 保持GamePilot运行。
2. Harness侧栏“插件”→“添加插件”，输入绝对本地目录 `D:/Projects/GamePilot/integrations/deepseek-harness/gamepilot-mcp`。
3. 选择“立即启用”，等待MCP启动和工具发现。
4. 更换电脑时先调整`cordis.patch.yml`中的Node、MCP脚本及cwd绝对路径；脚本默认连接同一Windows用户的`.gamepilot`。隔离profile用脚本已有的`--profile-dir`参数明确指定。

配置无需写入模型Key、游戏密码或本机控制token。脚本内部使用运行中App的本机连接机制，公开工具响应保持脱敏。

本地安装保留对该目录的链接，请保持目录位置稳定。修改配置后，在插件页关闭再开启此插件，或重启Harness，使配置重新加载。另一个电脑还需更新技能扫描目录的绝对路径。

启用后可在Harness聊天中使用 `gamepilot-control` 技能，例如“使用gamepilot-control，检查两个账号今晚的日常结果”或“使用gamepilot-control，运行保存的日常”。技能通过官方skill-filesystem提供，只使用现有GamePilot工具。

## 工具与执行边界

Harness实际模型工具名为`mcp__gamepilot__gamepilot_status`、`capabilities`、`events`、`command_review`、`command_confirm`、`stop`、`resume_review`、`resume_confirm`（后七个同样带完整前缀）。参数与执行约束以工具schema和[本机控制说明](../../docs/local-control.md)为准。

先读取status/capabilities，再预览保存的日常。宿主只接受“运行保存的日常”“运行每日任务”“运行双游戏日常”“/run-daily”四种文本；外部Agent把用户意图映射到对应文本，不能向现行schema添加laneId、gameId或skillIds。review要求当前GamePilot选中会话的真实sessionId；0.14.37起使用status.selectedSessionId并验证对应chatSessions项，两者来自同次快照。旧版缺字段时需升级，不能将第一项当成当前会话。

宿主确认仍核对reviewId、revision、账号、配置、历史和资源租约。submitted只是受理；最终结果通过events游标分页与正常App账本核对。events.limit范围1–100，使用返回cursor继续直到hasMore=false；未知/缺口不算成功。未知结果不重放、已完成业务不重做，停止只针对明确绑定的请求。若预览要求部分确认，先核对现场再提交acknowledgePartial，不能用它绕过同日门禁。

此适配只能调用现有八工具；未把内部read_skill、compile_plan、get_run等自动变成Harness工具。当前任意自定义账号/任务编译和原生日常完整结果摘要仍有接口缺口；当前会话由用户在App选择，Harness只读取事实。保存计划继续按08:00双游戏、20:00方舟运行；Harness无需建立竞争的第二个定时器。

本地配置依据来自已安装官方包内`@deepseek-ai/dsh-agent-preset`的`cordis-plugin-development/references/mcp-bundle.md`及`templates/mcp`，运行使用官方`@deepseek-ai/dsh-mcp-client`。本次只新增配置，不复制上游实现代码。
