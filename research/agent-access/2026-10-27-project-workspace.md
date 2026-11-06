# CLI 项目工作目录

- 日期：2026-10-27
- 状态：部分待验证
- 适用范围：macOS、Codex 当前内置 CLI、Claude Code 2.1.209、CodeBuddy Code 2.177.0
- 调研问题：将用户选择的项目目录作为对话工作目录，并保持认证与运行数据位置稳定。

## 结论

本机帮助确认Codex提供`-C/--cd`设置工作根目录，且`--cd <目录> app-server --help`解析成功。官方App Server协议支持`thread/start`和`turn/start`的`cwd`。本机Claude Code与CodeBuddy帮助没有对话根目录`--cwd`参数；两者从进程当前目录启动，`--add-dir`是额外访问目录，不能替代当前目录。

应用已实现按项目ID解析目录的原生会话预备配置。Codex同时设置进程目录、`--cd`及内部协议cwd；Claude/CodeBuddy设置进程目录。临时文件、安装与认证配置保持应用运行目录。前端不提交任意目录、可执行文件或命令。

## 依据与验证

| 来源 | 版本或访问日期 | 支持的结论 | 验证方式 |
| --- | --- | --- | --- |
| 本机官方Codex `--help`及`app-server --help` | 2026-10-27 | `--cd`支持，子命令组合可解析 | 只读帮助，不启动模型 |
| [Codex App Server](https://learn.chatgpt.com/docs/app-server) | 2026-10-27 | thread与turn的cwd字段 | 官方协议 |
| [Claude Code CLI](https://code.claude.com/docs/en/cli-reference)与本机帮助 | 2.1.209 | 当前目录语义、`--add-dir`用于额外目录 | 官方文档及只读帮助 |
| [CodeBuddy CLI](https://www.codebuddy.ai/docs/cli/cli-reference)与本机帮助 | 2.177.0 | 无`--cwd`；`--add-dir`扩展访问目录 | 官方文档及只读帮助 |
| `tests/agent-workspace.test.mjs` | 2026-10-27 | 受限项目ID、目录分离、路径含空格与非ASCII可用、符号链接替换拒绝 | 合成CLI真实进程执行与原生配置测试 |

帮助输出与测试证据位于`tmp/checks/agent-workspace/`；未保存真实认证输出或令牌。

## 未确定事项

当前学习对话UI和完整学习任务适配器尚未接入。已验证预备配置与合成进程工作目录；不能据此宣称所有真实模型、资料工具、权限或跨会话恢复已经通过。Qoder、OpenClaw、Hermes的目录参数随真实适配另行验证。

## 对开发的影响

选定工具后先调用项目会话预备，目录失效时要求重新定位，不以应用目录或用户主目录代替。后续所有实际会话必须通过原生预备配置启动；Codex创建和恢复会话时继续传同一cwd。工作目录不是沙箱，不扩展模型工具权限。
