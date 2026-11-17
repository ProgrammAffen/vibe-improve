# 对话附加图片与文档

- 日期 2026-11-16
- 范围为 macOS App 的规划问答、路线编辑和当前接入的三种智能体。

| 智能体 | 图片输入依据 | 验证 |
| --- | --- | --- |
| Codex | [App Server turn/start](https://developers.openai.com/codex/app-server#turns) 支持本地图片项 | 原生适配协议回放，确认请求引用项目内的图片快照 |
| Claude Code | [Agent SDK 流式输入](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode) 支持图片内容块 | CLI 2.1.209 向本机 Messages 模拟接口转发合成图片，返回成功 |
| CodeBuddy | [Headless Mode](https://www.codebuddy.ai/docs/cli/headless) 定义图片内容块，[模型配置](https://www.codebuddy.ai/docs/cli/models) 定义图片能力 | CLI 2.177.0 向本机聊天接口转发合成图片，返回成功 |

本地文档复用资料解析，截取有界的正文作为当前消息内容。发送前可移除附件。原件选中时创建快照，项目会话只保存文件名、类型和引用 ID。附件存于 App 运行目录的 `projects/chat-attachments/`，其中未被会话或当前输入框引用且超过一天的快照在下次添加时清理。图片识别的可用性和效果取决于所选模型。模拟接口验证覆盖传输，真实云端模型识别效果需要按模型验证。
