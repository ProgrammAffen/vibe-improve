# 素材与临时产物

## 目录

| 目录 | 内容 |
| --- | --- |
| `tmp/research/` | 下载、来源证据、许可核查 |
| `tmp/review/<批次>/` | 候选素材、原始参考、对比、样张与审阅说明 |
| `tmp/work/` | 一次性程序、试验、工作计划 |
| `tmp/checks/` | 测试日志、截图与结果 |
| `tmp/build/`、`tmp/runtime/`、`tmp/cache/` | 构建中间产物、开发学习库与缓存 |
| `output/` | 已验证的未压缩应用二进制；覆盖同名应用，保留同级运行时数据 |
| `assets/images/` | 已采用背景、角色、怪物、UI 图像 |
| `assets/video/`、`assets/audio/` | 已采用视频、音乐与音效 |
| `assets/fonts/` | 已采用字体及其许可文件 |
| `assets/models/` | 已采用模型、材质与动画 |
| `assets/other/` | 已采用的其他资产 |
| `assets/licenses/` | 资产需要随包分发的授权文本 |

正式资产清单为 [assets/manifest.json](../assets/manifest.json)，结构见 [Schema](../contracts/asset-manifest.schema.json)。素材不得散落在应用源码、公用目录或测试目录；构建时从清单复制。

## 入库

1. 将候选原件与预览放入 `tmp/review/<批次>/`，记录用途、来源、许可和尺寸/格式。参考图只授权参考，不自动授权商业再分发。
2. 用户明确选定后保存确认原话或消息标识。确认记录必须来自真实用户反馈，不能由 Agent 虚构；入库脚本只能检查字段，不能替代授权判断。
3. 用 `scripts/promote_asset.py` 复制原件到对应正式目录并登记哈希、来源、许可和确认。禁止覆盖同名资产；修订使用新文件名与 ID。
4. `scripts/check_harness.py` 检查登记、文件哈希、许可文件、目录越界及未登记素材。产品构建只消费通过检查的资产。

```sh
python3 -B scripts/promote_asset.py --source tmp/review/batch/hamster.png \
  --id hamster-idle-v1 --kind images --filename hamster-idle-v1.png \
  --source-url 'user-supplied' --license 'user-owned' \
  --license-evidence '用户确认拥有使用权的消息标识' \
  --approved-by user --approval-ref '真实确认消息标识' --approved-at 2026-10-14
```

上面的命令是格式示例，不能用示例确认文字冒充批准。需要随包分发的第三方许可证先存 `assets/licenses/`，通过 `--license-file` 登记。复杂素材的尺寸、锚点、坐标系、动画、时长、循环和降级资产在清单可选 `metadata` 中维护；修改后重新检查。没有实际选定素材时清单保持空。

## 已采用主页分层

当前主页采用用户于 2026-10-17 确认的无右上角最大化按钮版本，布局见 [window-layout](window-layout.md)。

| 层 | 正式素材 |
| --- | --- |
| 主页背景视频 | `assets/video/home-volcano-loop-1080p-v1.mp4`，1920 × 1080、24 fps、193 帧、约 8.04 秒，无音轨 |
| 静态背景 / poster | `assets/images/home-volcano-background-1920x1080.png`，用户选定原图，1920 × 1080，无标题、控件和黑边 |
| 固定透明标题 | `assets/images/home-title-vibe-improve-v1.png` |
| 无字按钮底板 | `home-menu-primary-blank-v1.png`、`home-menu-secondary-blank-v1.png`、`home-menu-exit-blank-v1.png`，位于 `assets/images/` |
| 独立图标 | `assets/images/home-icon-{play,folder,gear,exit}-v1.svg`、`home-icon-person-dark-v1.svg` |
| 无字账号胶囊 | `assets/images/home-account-capsule-blank-v1.svg` |

运行时分别叠加无字底板、图标和真实双语文本；加载与设置复用米色底板。当前视频采用用户确认的环境动态加快版，岩浆和烟雾动效速度约为初版的 2 倍，保留角色与喷火原速。背景视频只包含场景，静态 poster 用于加载、减少动态效果及失败回退；黑边由播放器绘制。标题是独立品牌图层。菜单文案及文本排版见 [experience](experience.md)。

## 已采用弹窗分层

认证、验证码、密码、设备移除、退出和功能提示共用 `dialog-frame-blank-v2.png`，面板按九宫格边框伸缩，包角不随内容拉长。该浅色木框与金属包角组合仅用于模态弹窗，不作为整页展示面。输入底板为 `dialog-field-blank-v1.png`，按钮复用主页无字石质底板。均位于 `assets/images/`，不含文字和图标。文字、字段值及 Lucide 图标由运行时独立绘制，按钮滤镜只处理底板。

## 设置素材

设置场景与非模态展示面按[界面规则](experience.md)审阅后入库，不使用模态木框。分类、返回和账户操作复用主页无字石质按钮底板；选择与开关保留独立控件素材。行底板为 `settings-row-blank-v1.png`，旋钮为 `settings-control-thumb-v1.png`，选择器与开关底板为 `settings-nav-{selected,neutral}-blank-v1.png`。标题、分类、设置项、图标、选项和状态由运行时独立显示。

## 项目页面素材

创建页采用 `assets/images/project-create-blackboard-scene-v1.png`：1672 × 941的开阔营地、黑板与03号简化切面背包金丝熊，不穿盔甲；角色与场景使用同一光照、透视和接地阴影。项目列表采用 `assets/images/project-grassland-scene-v2.png`：同尺寸的开阔低多边形草原，不放角色或缩略图；居中白色半透明遮罩由代码绘制。两张场景均无文字与可点击控件，不使用模态木框。字段、项目名称、进度、最近打开日期、打开/删除操作、分页、图标与双语文字独立渲染，按钮复用主页无字石质底板。用户确认、原始提示词、生成元信息及原件位于 `tmp/review/`，正式清单登记哈希与来源。

## UI 字体

UI 中英文采用可商用、可随应用分发的黑体，当前选用思源黑体 Source Han Sans CN。获取官方发行文件时核对其随附许可，保存来源、版本/提交、SHA-256 与许可原文；候选文件先放 `tmp/`，经采用后按入库流程登记字体及需随包分发的许可。不修改系统字体，不依赖外部字体 CDN。

按钮文字由代码排版，文字本身按按钮几何中心水平、垂直居中。图标独立置于左侧，文本区两侧预留对称空间；长英文可折行。Vibe Improve 固定立体标题保留字形风格，主页展示尺寸较首版火山主页审阅图放大约 15%，独立于按钮文字。

### ZCOOL KuaiLe 许可记录

2026-10-14 核实 Google Fonts 官方发行：**可用于商业软件和网页，也可随应用分发**。字体文件采用 SIL OFL 1.1；分发时保留版权声明与许可证，不单独出售字体。修改字体时遵守 OFL 和保留名称条款；不要把本应用声明为字体作者背书。

- [官方字体目录](https://github.com/google/fonts/tree/main/ofl/zcoolkuaile)
- [官方许可证](https://raw.githubusercontent.com/google/fonts/main/ofl/zcoolkuaile/OFL.txt)
- [官方元数据](https://raw.githubusercontent.com/google/fonts/main/ofl/zcoolkuaile/METADATA.pb)：Regular 400，简体中文和 Latin。
- [SIL 使用说明](https://openfontlicense.org/how-to-use-ofl-fonts/)

采用 ZCOOL KuaiLe 时从官方来源获取具体文件，保存来源、版本/提交与 SHA-256，并将字体文件和 OFL 按入库流程一同登记；未采用的字体样张或参考美术不进入正式素材库。

## 生成规则

图像生成用于场景、角色和无文字控件底图；固定标题可以生成文字。按钮、节点、输入与动态内容由代码排版。每份模型/精灵需记录尺寸、透明通道、锚点/坐标、动画状态与降级资源；音视频记录时长、音量和循环要求。

素材审阅只决定采用该素材，不扩大为发布、付款或上传私人内容的授权。不要在规范中保留被淘汰的图或方案说明。
