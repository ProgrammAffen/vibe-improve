# WorkBuddy 内置CLI与认证

- 日期：2026-10-26
- 状态：部分待验证
- 适用范围：macOS arm64；WorkBuddy 5.8.3、内置CodeBuddy CLI 2.161.0、Node.js 22.22.2。
- 调研问题：桌面安装能否用于App内CLI检测、登录与对话。

## 结论

事实：本机WorkBuddy官方应用完整签名通过，包标识为`com.tencent.workbuddy.mac`，Tencent Team ID为`FN2V63AD2J`。PATH没有codebuddy命令，应用内置`Contents/Resources/app.asar.unpacked/cli/bin/codebuddy`脚本。它需要Node.js 18.20.8以上；当前包仅携带WorkBuddy lite模块，启动须设置`CODEBUDDY_FORCE_LITE_WB_BUNDLE=1`。版本与帮助命令通过。

事实：关闭工具、MCP与会话持久化后，最小模型请求返回需登录，没有模型响应。用户确认桌面已经登录；官方认证文件中有加密token信封，SDK初始化能识别账号但没有可用token。读取时仅检查字段存在与类型，未导出凭据。桌面已登录不能直接作为CLI已登录的依据。

事实：SDK stream-json的`initialize`、`get_auth_methods`成功，认证方式是`workbuddy-desktop`。SDK `authenticate`返回`https://www.workbuddy.cn/login`官方登录URL。预览探测在用户授权前终止，没有完成OAuth或模型请求。缺少可用认证时，标准ACP初始化没有返回握手响应，不能以文档声明代替本机验收。

采用：App复用内置CLI的SDK控制通道，用户点击登录后进入官方网页。检测与登录使用同一应用运行目录，凭据由厂商CLI管理，不复制或解密桌面token。SDK认证不主动退出旧账号；当前版本ACP认证会先logout，故App不使用该认证入口。

## 依据与验证

| 来源 | 版本或访问日期 | 支持的结论 | 验证方式 |
| --- | --- | --- | --- |
| 本机Info.plist、官方签名及内置CLI脚本/SDK控制协议 | 5.8.3 / 2.161.0，2026-10-26 | 发行来源、Node要求、lite模块、初始化及认证方式 | 系统签名复核；真实CLI版本、帮助、模型请求与SDK探测 |
| [WorkBuddy headless](https://www.workbuddy.ai/docs/cli/headless) | 2026-10-26 | `codebuddy -p`与结构化输出 | 官方文档及当前CLI帮助 |
| [CLI命令参考](https://www.codebuddy.ai/docs/cli/cli-reference) | 2026-10-26 | 输入/输出模式与参数 | 官方文档；本机帮助核对 |
| [ACP](https://www.codebuddy.ai/docs/cli/acp) | 2026-10-26 | `--acp`和stdio协议 | 官方文档；缺少认证时未通过握手 |
| [认证说明](https://www.codebuddy.ai/docs/cli/iam) | 2026-10-26 | 官方CLI账号认证 | 官方文档；SDK登录URL实测 |

证据保存在`tmp/checks/agents/2026-10-26-workbuddy/`。探测关闭自动更新、遥测和IDE连接，写入范围限制在开发目录；输出仅保留阶段、布尔结果、版本与脱敏状态，不保留账号、token、授权URL参数或原始认证输出。原生替身测试覆盖登录完成、再次探测、取消、已登录不重登、加密信封拒绝与URL白名单。

## 未确定事项

- 用户完成CLI官方授权后的凭据持久化与跨进程恢复未验收。
- 登录后的真实模型响应、取消、权限、恢复、学习任务与ACP能力未验收，适配器仅登记probed。
- 未安装Node、其他WorkBuddy版本和国际版包标识仍需单独验证。

## 对开发的影响

`WorkBuddyAdapter.swift`负责该版本内置CLI协议；`AgentManager`复用现有检测、登录与取消入口。前端只接收provider、版本和规范化状态，未登录显示登录按钮；学习对话按后续范围接入。检测与登录不触发模型调用。规则见[Agent接入](../../harness/agents.md)。
