# macOS 壳

`main.swift`提供窗口、受限WKWebView桥与loopback静态资源服务；`RuntimeDirectory.swift`负责运行时目录和原子文件操作，`RuntimeLocation.swift`定位标准数据目录并迁移旧运行数据；`SessionCredentialStore.swift`负责加密会话；`WindowLayout.swift`负责初始内容尺寸；`DiagnosticLog.swift`提供本机诊断日志。由打包脚本统一编译。

`AgentManager.swift`负责可信Codex/Claude Code/CodeBuddy CLI发现、安装/认证探测、受控登录进程和默认/项目选择持久化；桥仅接收固定动作与provider ID，前端不能提交命令或路径。登录临时输出仅有界保存在内存，取消和超时终止本次进程；厂商凭据仍由其CLI管理。选择保存于运行目录 `agents/choices.json`，规则见[Agent接入](../../harness/agents.md)。

`CodeBuddyAdapter.swift`使用独立CodeBuddy npm CLI，通过SDK探测认证并以受控终端承载官方登录。`resources/codebuddy-cli/`随应用打包固定安装脚本、锁文件与发行文件指纹；一键安装只写`agents/codebuddy/`，不依赖WorkBuddy或开发tmp目录，不向前端返回账号、token及原始输出。

`RoutePreparationStore.swift`管理项目路线来源与导入草稿，使用原生文件选择器及打包的JavaScriptCore校验器。共享校验器从`packages/domain/route-validation.mjs`构建，契约与限制见[架构](../../harness/architecture.md)。路线准备写入运行目录`projects/route-preparation/`，预览凭据只存内存；导入不执行文件内容、不修改源文件或学习目录。

`PlanningStore.swift`使用同一`packages/domain/planning.mjs`打包的JavaScriptCore模块，原子保存`projects/planning/<projectId>.json`，单项目上限8MiB。四项核心清单按AI的语义完成判断更新；原生存储复核结构、消息关联、版本及晚到保护，不以关键词或逐字匹配判断回答。旧v1对话与进度兼容。重开恢复消息、清单、编辑稿与提案；仅新进程首次读取清理旧请求，不重发，不取消本进程活动任务。未完成编辑稿可保存，正式确认须完整v2校验；v1保留源并待补大章目标。提案采用和人工保存支持撤销与重做。确认后进入地图。开始、完成和跳过记录按项目与路线保存在运行目录 `projects/learning/<projectId>/<routeHash>.json`。原生桥核对路线修订、学习记录版本和前置条件，在项目锁内写入。路线写入检查已学小节保护；清空操作原子重置当前路线的全部学习记录。

`PlanningCoordinator.swift`仅接受固定`planning.*`操作，从原生保存的工具选择构建上下文；前端不能传任意提示词、命令或文件写入路径。`PlanningAgent.swift`支持Codex app-server及Claude Code / CodeBuddy stream-json文本协议，在用户选定项目目录启动；限制工具调用、输出、超时、取消和协议最终状态，完成后仍经Store验证。协议夹具验证与真实五项访谈验收分开记录，不以准备状态冒充对话成功。行为测试为`tests/planning-domain.test.mjs`、`tests/planning-coordinator.test.mjs`与`tests/planning-agent.test.mjs`。

日志位于`~/Library/Application Support/Vibe Improve/logs/`：`native.ndjson`、`native.1.ndjson`、`native.2.ndjson`。每份不超过1MiB，保留当前与最近两份，目录权限0700，文件0600。文件名固定，拒绝日志目录/文件软链与文件硬链接。写入失败不影响应用功能。

`window.vibeNative.log(entry)`只接收主框架、本站受信源且路径以`/vibe-improve/`开头的消息。重新筛选前端固定事件/操作/结果/授权状态，验证UUID、时间与长度，只保留诊断字段，不接受路径参数。

日志仅用于内部运行诊断，不提供用户设置项、导出或清除界面。原生桥不提供保存窗口或网页指定路径写入能力，不自动上传客户端日志。

原生日志记录启动、本地服务就绪/失败、远程加载/失败、离线回退与导航完成，仅使用固定事件及结果码。不记录网页URL、文件路径、账号、邮箱、安装ID、激活码、token、正文、异常message或stack。

运行`node --test tests/native-diagnostics.test.mjs`检查白名单、敏感字段剔除、权限、轮换及软链防护；测试仅在仓库`tmp/`写合成数据。

会话位于`~/Library/Application Support/Vibe Improve/auth/`，使用AES-256-GCM及实时硬件派生ID绑定，不使用系统钥匙串。通过IOKit读取IOPlatformUUID，按固定产品域SHA-256派生设备ID；原始UUID不保存或上报。独立device.json只保存v2派生记录，每次启动重新核对硬件，不使用磁盘标识。复制运行目录到另一台Mac不能恢复旧会话；旧未绑定硬件的会话要求一次性重新登录并确认绑定。正常同机更新不改变ID或登录状态。首次启动从旧应用同级运行目录原子复制项目与智能体数据，保留原文件；标准目录已有数据时不混合其他来源。读取硬件或迁移失败时停止启动。契约、迁移和保护边界见[登录保持](../../harness/license.md)。

窗口初始内容区按视频1920×1080等比适配可用工作区，并扣除原生标题栏，无初始黑边；用户后续缩放/全屏仍由原有contain画布补黑边。最终应用为仓库 `output/Vibe Improve.app`，构建验证后仅覆盖同名旧版，保留标准目录和旧运行目录，不生成压缩包。
