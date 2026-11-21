# 小节工作台 v1

工作台是已确认路线下、按小节持久化的有序学习文档，不是路线正文。公开文档形状见 [workspace schema](lesson-workspace.schema.json)，原生磁盘信封见 [storage schema](lesson-storage.schema.json)。生产与读取共用 [领域验证器](../packages/domain/lesson-workspace.mjs)，编辑器 JSON 不作为可执行 HTML。

## 身份与操作

- 身份为 `projectId / routeId / nodeId`。读取、保存及智能体开始请求都验证项目可访问、当前路线已确认、路线和小节 ID 存在。小节编号不参与身份。
- `lesson.read(identity)` 返回完整工作台；未保存过时返回 `schemaVersion:1 / revision:0 / blocks:[]`。
- `lesson.save(identity, expectedRevision, workspace)` 比较已存版本和候选版本，只在均等于预期版本时原子保存并递增一次。过期窗口、被清空前的候选和晚到智能体结果不能覆盖新版本；冲突返回 `LESSON_CONFLICT`。
- 智能体只读取已保存的内容，改写以提案返回。客户端采用后走相同保存入口，AI 不直接修改磁盘文档、路线或学习进度。
- 每块有稳定 ID、类型、独立折叠状态与 `records`。正文块保存 Tiptap JSON，公式块保存 LaTeX；资料块仅保存项目资料库的 `id/version`；链接块只保存 HTTP(S) 地址。资料原文件不复制进文档。
- `records` 是该块下的笔记或问答，保存标题、可选正文、主引用、最多 30 个其他块引用以及有序消息。主引用和其他引用支持文字、页码、起止毫秒。其他引用的块必须仍在当前文档中，删除被引块须同步移除引用。
- 新加入的资料引用必须属于当前项目的正式资料。已保存引用即使随后失效，也允许保留和修改笔记；预览及 AI 实际读取时仍检查资料版本和可访问状态。

## 存储与恢复

- 原生位置为 `Runtime/projects/lessons/<projectId>/<sha256(routeId + NUL + nodeId)>.json`。路径组件不采用用户标题，不接受客户端传入的文件路径。文件和目录沿用 `RuntimeDirectory` 的权限、禁止链接逃逸、跨进程锁和原子替换。
- 磁盘写入 `storageVersion:1 / notebookResetRevision / workspace` 信封。最初实现的裸 workspace 按重置版本 0 兼容读取，不丢弃内容；下一次保存或恢复升级为信封。业务桥仍只返回 workspace。
- 浏览器预览使用 `vibe-improve.lessons.v1` IndexedDB 的 `workspaces`，按三个身份字段组成键。保存信封另携带顶层身份以供索引。读写和路线进度变更使用同一项目锁。桌面 WKWebView 不依赖 localStorage 或浏览器缓存保存业务文档。
- 新进程读取时将遗留 `pending` 消息改成 `incomplete`，保留已收到的文字并增加版本，不重启旧 CLI 请求。
- 用户确认清空整条路线学习记录后，进度文件在同一次原子提交中写入 `notebookResetRevision = 新 progressRevision`。工作台每次读写先比对该值，未应用的文档删除正文/公式块以及全部问答笔记，保留原始资料和链接块。应用后增加 workspace 版本并记录已应用的重置值。原始资料库及文件不删除。
- 重置值先提交，因此即使清空后立即退出，也不会重新显示旧内容。旧窗口和晚到 AI 结果使用旧版本保存会冲突；后续普通进度更新不会再次清空新笔记。该操作是应用层记录重置，不承诺存储介质的取证擦除。

## 验证边界

- 文档最大 2 MiB UTF-8、500 个块、合计 2,000 条记录，每条至多 300 条消息；消息 100,000 字符、标题 500、引用 10,000、LaTeX 10,000。ID 全文档唯一。
- Tiptap 仅接受注册的文本、段落、标题、列表、引用、代码、换行、分隔线和公式节点及受限属性/标记；树深至多 32、单个编辑器文档至多 20,000 节点。拒绝 HTML/script/iframe 节点、任意样式及事件属性。
- 编辑器和资料链接都仅允许 HTTP(S)，拒绝凭据、反斜杠、空白和控制符。无法转成受支持编辑节点的 HTML/Markdown 由编辑器保留为代码文本，不执行脚本。
- JSON schema 描述外形与基础长度；跨记录唯一性、引用存在、Tiptap 属性白名单、聚合数量、时间顺序和字节总量由同一领域验证器执行。原生打包的是该验证器，不另写宽松解析。

## 原件预览

`lesson.preview(identity, {id,version})` 只接受引用。可访问范围是当前小节绑定的资料或已保存工作台中的资料。网页返回已验证的公开 HTTP(S) 原地址；本地文件返回当前 loopback 下的随机、短期预览能力地址和 MIME/名称，不返回路径。

loopback 端点校验 Host、Origin、能力令牌、当前作用域、资料版本以及原文件身份，支持 HEAD 和单区间 Range；单个 Range 响应至多 8 MiB，准确返回本次 Content-Range 与 Content-Length，播放器可续读。无 Range 的大文件保持完整 200 响应并以至多 64 KiB 的块流式发送；HEAD 只返回元数据，不读取正文。仅提供 PDF、安全光栅图片、影音及纯文本/Markdown；不提供 HTML/SVG 执行预览。响应禁止缓存和 MIME 嗅探，文件替换、已删资料、失效令牌与越界路径均拒绝。此预览读取原件，不把附件状态伪装成已解析资料。

## 验收入口

- [工作台测试](../tests/lesson-workspace.test.mjs)：文档与引用、重置保留范围、冲突、原生重启、权限及安全预览。
- [设置与学习进度测试](../tests/lesson-settings.test.mjs)：已有进度兼容、清空后的重置版本及过期请求。
- [富文本测试](../apps/local-ui/src/lesson-editor/rich-editor.test.mjs)：公式输入、Markdown 往返、链接与 HTML 导入边界。
