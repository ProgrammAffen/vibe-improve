# 云端与部署

## 目标与归属

- CloudBase 环境名：`one-person-company`；环境 ID：`one-person-company-7dao3979fd72e`。地域由环境查询确认，不从 ID 猜测。
- 云函数、数据库集合/索引/权限定义、初始化与部署脚本同仓维护。`../reference/` 仅只读借鉴，不作为发布依赖。
- CloudBase 当前仅作后台，负责身份认证、数据库、license、设备绑定和云端日志。桌面界面与素材随安装包分发，不使用 CloudBase 静态托管。
- 中间构建输出、部署计划、日志与联调证据进入 `tmp/`；最终桌面可执行应用进入 `output/`。只上传构建产物白名单，不上传 `tmp/`、凭据、研究文档或整个仓库。

## 身份与权限

- 邮箱认证采用锁定版本的 CloudBase SDK 或经契约测试的身份认证 HTTP API。注册、找回和改密使用平台真实邮件验证码，不在业务库保存明文密码。
- `@cloudbase/js-sdk`设置`persistence: 'none'`和OAuth内存`storage`，不让SDK写入浏览器令牌。桌面通过受信原生桥将两种会话令牌加密存于运行时文件夹，有效本地窗口和签名授权内直接恢复；访问云端时才按需刷新，临近7天合并身份检查与设备续租；生命周期和失败规则见[license](license.md)。普通浏览器开发预览仍只用内存会话。浏览器偏好、随机安装 ID 与脱敏诊断可持久化；诊断不含身份或凭据，按[日志规范](observability.md)关联云端请求。
- 客户端的公开环境标识不等于管理员凭据。腾讯云密钥、环境级管理 API Key、license 私钥只在服务端或部署工具内使用。
- 注册确认后建立账号会话，再检查产品权益和设备；身份认证不等于 license 激活。
- 改密/重置后退出当前会话并重新登录；跨设备令牌撤销单独实测，遵循 [license](license.md)。验证码失败、账号失效、设备超限、授权网络失败分开处理。
- 授权事件云函数自行鉴权、校验用户归属、限制请求大小与速率；不信任客户端提交的 `userId`、权限、设备数量或有效期。
- 使用 SDK `callFunction` 的事件函数只从平台第二参数 `context` 获取调用用户；不能把 `event.context` 或请求体当作平台上下文。匿名/未知身份拒绝。HTTP Server 另行验证访问令牌，不能依赖事件函数的环境身份方法。
- 平台函数调用权限和函数内鉴权分别验收。读回 `license-api` 的有效平台规则，要求登录且非匿名；若规则在环境级共享，保留其他函数与通配规则的原有行为，不以服务端判断冒充平台配置。
- 激活码、权益、设备、会话与续租记录禁止普通客户端直接读写。服务器通过受控接口处理事务。
- 激活兑换、设备席位与幂等结果在数据库事务内提交；使用确定性文档 ID，事务内不发邮件、不请求外部服务。

## CLI 与环境

默认认证客户端`MaxDevice=50`，允许多设备保持登录；License授权席位独立控制，当前2台。使用`node scripts/configure-auth-sessions.mjs --check`读回，`--apply`仅修改会话上限，不更改令牌期限或License席位数。

设备上限由云函数`LICENSE_MAX_DEVICES`配置，范围1–100。管理员调整`cloud/cloudbase.json`的`license.maxDevices`并仅部署`license-api`即可生效，不编译App、不换激活码、不修改客户端。在线绑定和续租立即执行新上限；设备列表返回实时上限，客户端同步加密快照。旧离线租约仍受原签名截止限制，不能声称后台改配置能即时撤销离线设备。

- 依赖和 lockfile 锁定 CLI/SDK 版本。部署前按实际安装版本的帮助检查命令；当前官网包含本机旧版 CLI 不支持的能力。
- CLI 配置、缓存与日志隔离在仓库 `tmp/runtime/` 内；不更改系统 `HOME`、全局默认环境或既有全局凭据。
- 统一从 `node scripts/cloudbase-cli.mjs <args>` 调用 CLI。包装器将 Node homedir、XDG、npm 缓存和临时目录指向项目 `tmp/runtime/cloudbase-cli/`；XDG_CONFIG_HOME 与 Node homedir 下 `.config` 使用同一目录，统一主 CLI 与内嵌 SDK 的认证存储。拒绝工作区外文件写入；`--diagnose` 仅展示版本与隔离位置。
- 基础资源由 `node scripts/cloudbase-manage.mjs inspect|plan|apply|verify` 管理，读取 `cloud/schema/license-schema.json`；仅创建 `vi_` 集合、收紧本应用集合权限和补充所需认证/来源，不删除资源。计划与脱敏证据进入 `tmp/checks/2026-10-18-cloudbase/`。
- 带密码的管理员请求通过包装器私密 stdin 通道传递，不把密码放进 shell 或操作系统命令参数；API 原始返回不打印。测试账号凭据与测试原始激活码仅保存在 `tmp/private/e2e-credentials.json`，权限 `0600`。
- 激活码可用 `node scripts/license-publish-cli.mjs --write ...` 生成并通过已授权 TCB 会话发布，只向数据库写入 hash 和权益参数；输入输出格式与 `scripts/license-create-codes.mjs` 一致。发布后按确定 ID 读回，不覆盖已使用的码。
- 原码批次生成后不可修改。发布状态只写相邻的 `.publication.json`，包含 hash、验证结果与时间；失败后用 `--write --input <原码批次>` 继续，不重新生成或覆盖原码。回执与测试凭据以同目录 `0600` 临时文件、文件 fsync、rename 和目录 fsync 原子更新。
- 每个资源命令显式指定环境 ID；先查询环境、函数与托管状态，再生成部署计划。
- `tcb login` 是授权操作，不能当作纯只读登录检查；未登录时提示用户完成平台授权，凭据不进入对话或日志。
- NoSQL 集合/索引采用独立的幂等初始化脚本。不能假定声明式 PostgreSQL 迁移会创建 NoSQL 集合。
- 新环境首次配置邮箱登录方式、邮件发送能力、安全来源与 HTTP 网关；以联调结果确认，不用配置文件存在代替部署成功。

## 后台与客户端交付

- `cloud/cloudbase.json` 标记 `role: backend-only`；`deploy-cloudbase.mjs` 只部署云函数，拒绝 `hosting`。
- 桌面只打开安装包内的界面。背景视频、字体、标题和按钮从本机加载；CloudBase 网络请求只用于后台服务，不从云端加载应用页面或素材。
- 主框架导航与原生桥仅接受本次启动的 loopback 端口及 `/vibe-improve/` 路径。公网网页不能调用原生桥。
- 后台发布后验证真实身份、激活、设备与云端日志；桌面本地来源分别实测登录与云函数调用。管理接口曾拒绝新增本地来源，不等于已证明现有SDK请求失败；以实际请求结果判定。
- 安全来源变更遇套餐限制时保留现有配置；禁止自动升级、购买套餐、放宽鉴权或伪造允许来源。
- 网页端以后独立部署，保留 Cloudflare 接口；未明确启用前不发布公网前端。

## Cloudflare 扩展接口

- 保留 `DeploymentProvider`：`plan(artifact, config)`、`deploy(plan)`、`verify(release)`；返回 provider、站点 URL、API URL、版本引用与验证结果。
- `cloudbase` 当前实现后台云函数发布；网页端 `cloudflare` 暂保留适配边界，不返回虚构成功。
- Cloudflare 前端可消费同一静态构建目录，后端通过 `API_BASE_URL` 指向 CloudBase；以后按需增加 Workers 代理，领域逻辑不依赖 provider。
- Cloudflare 私密绑定使用平台 Secrets；普通 `vars` 仅存非敏感配置。未提供 Cloudflare 账号与授权时不部署。
- 当前背景视频若超过 Cloudflare Pages 单文件限制，须在接入时选择媒体托管或适配编码，并验证访问与循环；不静默丢弃动态背景。

核实来源与验证范围见 [CloudBase/TCB 调研](../research/cloudbase-tcb/2026-10-18.md)。
