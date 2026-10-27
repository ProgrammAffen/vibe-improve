# WorkBuddy 内置 CLI 认证与真实对话排查

- 日期：2026-10-27
- 状态：认证恢复原因已定位；进程内认证的真实两轮对话通过；生产适配待完成。
- 适用范围：macOS，WorkBuddy 5.8.3，内置 CodeBuddy CLI 2.161.0，Node.js 22.22.2。
- 问题：桌面已登录，内置 CLI 为什么仍不能返回回复。

## 结论

内置 CLI 能进行模型对话。本机默认独立启动失败的直接原因是桌面凭据无法解密，恢复出的 accessToken 缺失；不能据此判定 WorkBuddy 内置 CLI 不支持交互。

本机证据形成以下链路：

1. 桌面认证文件的 accessToken、refreshToken 是 `$wbEncrypted` 加密信封。只检查类型，未记录值。
2. CLI 的凭据保护报告记录 `adapter=credential-fields`、`resource=auth/workbuddy-desktop.info`、`operation=read/write`、`category=missing-key`。
3. 内置源码在凭据解码失败时删除内存对象中对应字段。桌面 managed 启动通过受控 socket 初始化凭据保护；本次独立启动走 standalone 分支，没有这项初始化。
4. 默认启动的 SDK initialize 没有可用 token。随后账户请求的认证头分类是 `bearer-undefined`，账户接口返回 HTTP 401；没有发出模型请求。user 消息以 `error_during_execution` 结束，提示 Authentication required。
5. 使用内置实现提供的 `CODEBUDDY_CREDENTIALS_IN_MEMORY=1`，在同一 SDK 进程完成官方认证，再发送两条合成消息，账户接口和两次模型请求均返回 HTTP 200，两轮回复严格匹配随机口令。第二条消息不含口令，验证了上下文记忆。

第5项是诊断对照，不修改桌面加密设置，不复制桌面 token，不取得或伪造 sidecar 密钥。成功测试带有只观察请求元数据的 Node 钩子，未改变认证头或业务请求。后续无钩子复测停在官方账号选择等待并超时，没有形成第二份成功对话证据；不把授权等待失败写成模型不支持。

## App 侧的衔接问题

`WorkBuddyControl.receive` 收到 SDK authenticate 的 success 后调用 `job.stop("finished")`，结束登录进程。`WorkBuddyAdapter.probe` 每次再启动一个新 CLI。新进程仍需从受保护的桌面文件恢复凭据，因此会再次缺少 token。现有 App 的运行目录设置不能替代厂商的凭据保护初始化；认证文件路径使用厂商的 sharedDataPath。

官方认证响应成功、当前进程有 token、下一进程能恢复认证、实际模型回复成功是四个不同的验收项。先前正常模式中“认证成功后模型仍失败”的单次记录没有完整网络跟踪，不能把它解释为账号无权限或产品不能聊天。

## 运行方式与接入边界

| 方式 | 本机结果 | 边界 |
| --- | --- | --- |
| 直接启动内置 CLI，恢复桌面认证 | missing-key，账户401，无模型请求 | 当前启动没有 managed 凭据初始化 |
| 内置 CLI，官方进程内认证，同一进程多轮 | 两轮真实回复通过 | 进程结束后认证不持久化，不能另起进程复用 |
| 桌面 managed sidecar 初始化 | 只读代码确认机制存在 | 尚未完成第三方正式连接，不提取私有初始化密钥 |
| 独立 npm CLI 2.177.0 | 真实回复、两轮、跨进程认证复用通过 | 独立产品及认证环境，见[独立CLI报告](2026-10-27-codebuddy-code.md) |

内置 CLI 若采用进程内认证，运行时须持有登录后的进程，检测和对话复用它；不能登录后立刻销毁，也不能以新进程探测替代活动会话状态。该方式必须显式处理程序重启后的官方重新认证，并在完整适配前验证取消、权限、错误及恢复。它不等于已解决跨重启登录保持。

生产接入若要求直接复用桌面加密登录态，需要厂商支持的 managed 初始化方式，当前尚未验证。不要通过复制 token、提取桌面密钥、关闭加密或修改厂商安装文件解决。

本次只修正诊断结论与接入规范，未切换 App 运行方式、未重新打包，WorkBuddy 能力登记仍为 probed。

## 证据与隐私

证据目录：`tmp/checks/agents/2026-10-27-workbuddy-cli/`。

- `default-final.json`、`default-final-network.jsonl`：默认启动，无 token、账户401、模型请求未发出。
- `credential-failure-summary.json`：仅从本次运行目录的日志提取公开错误分类，含 missing-key 读写记录。
- `memory-login.json`、`memory-login-network.jsonl`：官方进程内登录成功，真实两轮回复及两次模型200。
- `source-findings.json`：内置文件哈希与代码定位名称。
- `memory-clean*.json`、`persistent-login.json`：未完成账号选择的认证等待失败，不作为对话验收。
- `summary.json`：本次结论与验收边界。

网络观察器只记录请求类别、官方主机名、认证字段存在与格式分类、状态码；不记录完整 URL、查询参数、请求/响应正文、账号、令牌或密码。合成测试关闭工具、MCP、用户项目配置和会话持久化，没有读取学习资料。认证 URL 临时文件在进程结束时清除。

依据是本机已签名安装、内置公共实现、实际官方服务请求和合成回复，限定于上述版本；不推断所有版本均有同样表现。
