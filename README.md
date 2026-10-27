# Vibe Improve

金丝熊魔法冒险学习 Skill。当前可运行增量包含动态主页、森林设置、独立账户、CloudBase 邮箱认证与设备 license，以及项目名称/目录、智能体选择、草稿保存和项目列表；路线规划、Agent 学习和同步后续接入。

## 运行与打包

依赖、缓存和构建中间产物留在 `tmp/`，最终应用放在 `output/`。Node 22、Python 3.11+；macOS 打包需要 Xcode Command Line Tools。

```sh
mkdir -p tmp/dependencies/app
cp package.json package-lock.json tmp/dependencies/app/
npm ci --prefix tmp/dependencies/app --cache "$PWD/tmp/cache/npm" --no-audit --no-fund
ln -s "$PWD/tmp/dependencies/app/node_modules" node_modules
npm run prebuild
npm run dev
```

本地地址：`http://127.0.0.1:5173/vibe-improve/`。已有 `node_modules` 时不重复建立链接。

```sh
npm run build
node scripts/package-mac.mjs --arm64
```

输出：`output/Vibe Improve.app`，无需解压，直接打开。同名旧版在构建和签名验证通过后覆盖；保留同级运行时文件夹，不生成压缩包。`--intel` 构建 Intel 版本。当前签名为 ad hoc，未公证。桌面始终加载安装包内的界面、动态视频与字体；CloudBase仅作后台，身份和授权操作需要联网。运行数据存 `.app` 同级 `Vibe Improve Runtime/`：偏好、独立device.json安装身份、内部日志和加密会话/租约。密码不保存；7天内按令牌有效期恢复登录，未到期不重复查询后台，令牌临期才刷新，主动退出或改密后清除会话。旧偏好中的设备ID迁入device.json；output运行目录缺失时从旧构建目录无损迁移身份和成对加密会话，已有output运行目录不覆盖，原文件保留。更新或移动应用时保留并带上运行时文件夹。文件边界见 [license](harness/license.md)。

## 项目草稿

运行数据目录与系统例外见[存储分层](harness/architecture.md#存储分层)。登录采用7天本地检查窗口并自动续期；授权过期、撤销或证书校验失败停用授权功能，保留有效账号登录。更新应用不会清空运行目录。

项目草稿保存在应用同级 `Vibe Improve Runtime/projects/`，支持分页、滚动、打开、修改、从列表移除和重新定位目录；未提交表单自动保存。草稿阶段不创建目标项目文件夹，路线采用后再建立正式学习库；该阶段进度显示“待规划”。项目数据仅保存在本地。

名称与目录保存后进入智能体选择页，首项“无智能体，手动创建”与六款工具同组单选。Codex、Claude Code与CodeBuddy检测可信CLI及认证，未登录时提供登录入口；CodeBuddy未安装时支持一键安装。设置可随时重新检测，默认与项目选择独立保存至运行目录`agents/choices.json`。当前下一步保存准备结果后返回列表，学习路线与对话界面后续接入。

CodeBuddy使用官方独立npm CLI 2.177.0，需要Node.js 18.20.8以上版本及npm，安装、配置和缓存位于`agents/codebuddy/`。不依赖WorkBuddy桌面端，不全局安装；国内站登录支持跨进程复用。实测与限制见[CodeBuddy调研](research/agent-access/2026-10-27-codebuddy-code.md)。


## 云端

环境：`one-person-company-7dao3979fd72e`，上海。仅部署认证、license、设备与日志后台，不部署前端页面。

```sh
node scripts/cloudbase-cli.mjs login
node scripts/cloudbase-manage.mjs inspect
node scripts/cloudbase-manage.mjs apply
node scripts/deploy-cloudbase.mjs function
```

隔离 CLI 使用 `@cloudbase/cli@3.2.2`，当前可读已安装版本，状态仅写 `tmp/runtime/cloudbase-cli/`。首次部署须安全生成 Ed25519 私钥到 `tmp/private/license-signing-key.pem`，登记对应公开验证密钥；不能只替换其中一端。密钥轮换须保留旧公钥直到旧租约失效。

桌面与本地开发直接连接CloudBase后台。正式验收使用本地客户端；Cloudflare网页端接口保留，当前不部署。

管理员生成激活码：

```sh
node scripts/license-generate-v2.mjs --duration-days 7 --count 1 --output tmp/private/codes.json
```

新码使用独立Ed25519激活密钥离线签发，无需预录数据库，首次兑换起计时；原码只保存在新建私密文件，数据库仅存hash。激活密钥配置见[license](harness/license.md)。旧VI1发布脚本仅用于原批次兼容恢复。云函数及数据定义见 [license-api](cloud/functions/license-api/README.md)、[schema](cloud/schema/license-schema.json)。Cloudflare 预留 [provider 接口](packages/deployment/provider.ts)，当前不部署。

## 开发与验证

从 [AGENTS.md](AGENTS.md)、[交付顺序](harness/delivery.md) 和 [开发 Skill](skills/vibe-improve-dev/SKILL.md) 进入。界面规范见 [experience](harness/experience.md)，[CloudBase / TCB 调研](research/cloudbase-tcb/2026-10-18.md) 区分官方接口与真实联调范围。

运行代码内置诊断日志，不提供用户设置项或日志管理界面；内部云日志查询使用 `node scripts/read-runtime-logs.mjs --client-trace <UUID>`；记录范围、容量、隐私与云端关联见[日志规范](harness/observability.md)。

```sh
npm test
python3 -B scripts/check_harness.py
python3 -B -m unittest discover -s tests -v
```

源码在 `apps/`、`cloud/`、`packages/`；正式素材在 `assets/`；调研在 `research/`；审阅、下载、缓存、凭据与构建在不提交的 `tmp/`。harness 检查通过不代替真实邮箱、授权或 Agent 验收。
