# 调研结果

保存开发过程中整理完成的调研结论，包括 Agent 接入、技术选型、学习方法、交互、素材授权与商业方案。

## 目录约定

- 结果：`research/<topic>/YYYY-MM-DD.md`，topic 使用简短英文名称，同主题按日期保留版本。
- 草稿、下载原件、网页摘录与实验：`tmp/research/<topic>/`。
- 待审阅报告与对比材料：`tmp/review/<批次>/`。
- 正式采用的开发资产：`assets/`，遵循[素材流程](../harness/assets.md)。

每份结果使用[记录模板](TEMPLATE.md)，注明调研日期、适用版本、来源、验证方式和未确定事项。事实、推断和建议分别表述；来源变化后复核并标注过期结果。

调研结论作为决策依据；选定的开发方案同步到对应 harness 文档。产品运行时不依赖此目录。

## 结果索引

归档结果时在此添加主题、日期、结论摘要与文件链接。

| 主题 | 日期 | 结论摘要 | 文件 |
| --- | --- | --- | --- |
| CloudBase账号与激活参考 | 2026-10-14 | 邮箱验证码与设备激活客户端可复用，云端源码与生产配置待验证 | [结果](cloudbase-account/2026-10-14.md) |
| CloudBase / TCB 实际接入 | 2026-10-18 | 官方认证 SDK、隔离 CLI、真实专用集合与托管；本地来源套餐限制及真实邮件验收边界 | [结果](cloudbase-tcb/2026-10-18.md) |
| 主页金丝熊抵挡龙焰循环 | 2026-10-14 | 3D 骨骼场景离线渲染视频播放；画质、循环与性能待实测 | [结果](home-loop-animation/2026-10-14.md) |
| 3D 角色与骨骼动画 | 2026-10-14 | 分离角色、多视图建模、Blender 修正绑定与同步动作；自动绑定范围需区别网页与 API | [结果](rigged-3d-characters/2026-10-14.md) |
| 登录自动续期与多会话 | 2026-10-20 | 7天按需静默刷新、平台50会话与License两席分离；双客户端恢复及绑定确认实测通过 | [结果](cloudbase-session/2026-10-20.md) |
| 智能体图标与CLI接入 | 2026-10-25 | 七款官方图标已收集；Codex最小CLI对话通过，Claude Code未登录，其余五款未安装；创建与设置共用接入入口 | [结果](agent-access/2026-10-25.md) |
| TRAE 中文版发现与CLI边界 | 2026-10-26 | 已发现个人版Trae CN与trae-cn，显示仅IDE；独立traecli当前限定企业旗舰版，本机未安装 | [结果](agent-access/2026-10-26-trae-cn.md) |
| WorkBuddy内置CLI与认证 | 2026-10-26 | 官方内置CLI和SDK初始化、登录URL通过；桌面加密凭据不等于CLI可用，授权后模型待验证 | [结果](agent-access/2026-10-26-workbuddy.md) |
| 登录检测与TRAE命令复核 | 2026-10-27 | WorkBuddy生产探测仍需登录；trae-cn chat帮助通过，独立traecli及套餐边界分别验收 | [结果](agent-access/2026-10-27-status.md) |
| TRAE个人版真实对话与CLI测试 | 2026-10-27 | 桌面合成回复通过；trae-cn chat未送入问题，普通文本/文件均可作为后续接入方式 | [结果](agent-access/2026-10-27-trae-chat.md) |
| WorkBuddy内置CLI真实请求 | 2026-10-27 | 默认启动缺少桌面凭据密钥、账户401；官方进程内认证后两轮真实回复通过，跨进程恢复未通过 | [结果](agent-access/2026-10-27-workbuddy-builtin-cli.md) |
| CodeBuddy独立CLI | 2026-10-27 | 官方npm 2.177.0国内站真实回复、两轮上下文和登录进程退出后的新进程认证复用通过 | [结果](agent-access/2026-10-27-codebuddy-code.md) |
| CodeBuddy替换与一键安装 | 2026-10-27 | App替换WorkBuddy并移除TRAE；托管安装、认证保持、两轮真实回复与取消保护验证 | [结果](agent-access/2026-10-27-codebuddy-integration.md) |
