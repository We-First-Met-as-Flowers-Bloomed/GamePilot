# Project rules

- 当前设计依据 docs/architecture.md，任务计划 docs/plans/2026-09-14-foundation.md。
- 不修改上层参考文件。不把 node_modules、dist、artifacts 或运行数据提交到 Git。
- 游戏业务只能位于 games；renderer 不导入 Node/Electron/Maa。
- main 不加载 Maa 原生模块，所有引擎调用在独立 worker。
- 演练必须显式标记，不得将未验证的游戏技能显示为可执行。
- 改动后运行 npm run verify；实机能力单独验证。
- 发行包保留最新两版及正在使用/启动引用的版本。打包后自动运行安全保留；若从工作树移动发行包到正式 release，须在正式根再次运行 scripts/release/prune-releases.mjs（先预览，确认候选后 --apply）。引用不明、额外文件或链接检查失败时不得强删。
- 验证证据保存日志、截图及发行 manifest/hash 引用，不将整个发行包复制到 artifacts；不得将共享 node_modules/vendor junction、账号数据、原账本或全局依赖 store 当缓存递归删除。
