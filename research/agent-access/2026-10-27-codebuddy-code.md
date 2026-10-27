# CodeBuddy Code 独立CLI测试

- 日期：2026-10-27
- 状态：基础CLI对话可用，产品适配器待完整验收
- 适用范围：macOS、Node.js 22.22.2、@tencent-ai/codebuddy-code 2.177.0、国内站；连续对话实际模型hy4-preview。
- 调研问题：独立npm发行版能否完成认证、真实回复、连续对话及跨进程认证恢复。

## 结论

事实：用户提供的npm包与官方安装文档一致。已从registry.npmjs.org隔离安装锁定版本2.177.0，安装和缓存位于仓库tmp，关闭安装脚本，未修改全局安装或生产依赖。包版本、入口、锁文件完整性与入口哈希均已记录，实际版本和帮助命令通过。

事实：用户通过官方交互式CLI生成的国内站登录页面完成授权。固定`CODEBUDDY_INTERNET_ENVIRONMENT=internal`并复用同一`CODEBUDDY_CONFIG_DIR`后，全新CLI进程可读取认证。国内站与国际站必须分别检测，不能把默认国际站的未登录结果用于国内站账号。

事实：独立headless真实请求通过。关闭工具、MCP与会话持久化，发送仅回复随机标记的合成问题，CLI返回完全一致的标记、result success、is_error=false、退出0。没有认证、网络或写入权限错误。

事实：SDK stream-json连续两轮通过。第一轮提供随机标记并要求记住，第二轮不含标记，只要求回忆上轮标记；两轮均返回完全一致的标记与成功终态。模型标识为hy4-preview，未据此推断其他模型、工具或权限能力。

事实：登录用的自有测试进程全部结束后，再次启动新的headless进程，仍可直接完成真实回复，无需重新扫码。本轮验证了认证跨进程持久化；未覆盖系统重启、长期过期刷新或其他机器。

结论：独立codebuddy-code 2.177.0可通过CLI完成真实对话、连续上下文和跨进程登录复用，不要求厂商聊天窗口承载对话。App已改用此入口；实现与验证见[接入落地](2026-10-27-codebuddy-integration.md)。

## 接入约定

- 国内站在进程启动前设置`CODEBUDDY_INTERNET_ENVIRONMENT=internal`；检测、登录和对话使用相同环境及配置目录。
- 登录采用本次已验证的官方交互式终端流程，用户在官方浏览器页面完成授权；运行时持有本次CLI，过期即结束并重新发起，不复用旧授权链接。
- 对话可使用`codebuddy -p`的JSON结果或SDK stream-json；标准输出、终态、错误标志和结果内容共同验收。不能仅依据退出0或认证接口成功判定可对话。
- 凭据由官方CLI保管，不复制token、密钥或浏览器存储；前端只接收规范化结果。
- CodeBuddy独立包认证ID为Tencent-Cloud.coding-copilot，WorkBuddy桌面内置包为workbuddy-desktop；两者的认证、模型和权益分别验证，不预设额度共享。

## 依据与验证

| 来源 | 版本或访问日期 | 支持的结论 | 验证方式 |
| --- | --- | --- | --- |
| npm官方注册表 @tencent-ai/codebuddy-code | 2.177.0，2026-10-27 | 包名、版本、入口与完整性 | 元数据、锁文件、入口哈希、实际版本和帮助 |
| [官方快速入门](https://www.codebuddy.cn/docs/cli/quickstart) | 2026-10-27 | npm安装命令与交互式国内站登录 | 文档与真实CLI核对 |
| 安装包随附环境变量参考、product.json与product.internal.json | 2.177.0 | 国内站环境变量、独立认证入口 | 当前发行包原件；实际新进程复查 |
| 本机CLI与SDK实测 | 2.177.0，2026-10-27 | 真实回复、两轮上下文、跨进程复用 | 合成标记精确匹配及成功事件 |

证据在`tmp/checks/agents/2026-10-27-codebuddy-code/`：installation-verification.json记录来源与哈希；sdk-result.json记录认证布尔状态；chat-result.json为登录进程结束后的独立调用；session-result.json为两轮对话；login-process-cleanup-verification.json确认没有遗留登录进程，临时授权URL已清除；synthetic-transcript.md提供合成问题与已匹配回复。stdout原文、账号、token、授权URL参数和真实学习资料未保存。历史授权前失败结果单独保留，不冒充最终结果。

安装目录为`tmp/tools/codebuddy-code/`，运行目录为`tmp/runtime/codebuddy-code/`。本次允许厂商必要认证数据写入，其余测试文件留在开发目录；测试未读取用户学习资料。

## 未确定事项

- 工具执行、MCP、文件生成、权限请求、取消、故障恢复及长会话尚未验收。
- 系统重启、凭据过期后的刷新和跨设备认证尚未验收。
- CodeBuddy独立账号与WorkBuddy权益关系未确认，不预设共享。

## 对开发的影响

App已接入独立CLI的安装、探测与官方登录；不能将基础对话测试升级为整个学习任务适配器verified。当前App仍使用原有内置包适配逻辑，没有修改或重新打包App。执行边界见[Agent接入](../../harness/agents.md)。
