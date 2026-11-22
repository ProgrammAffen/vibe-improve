# 路线学习进度

进度按 `projectId / routeId` 隔离。路线修订与 `progressRevision` 在写入时同时校验；重复开始、完成或跳过同一小节不重复递增进度修订。

- `startedNodeIds` 记录已开始的小节，`completedNodeIds` 记录自评完成的小节。
- `skippedReasons` 保留已有存储与桥接字段名，但**键是否存在**才表示已跳过；新跳过使用空字符串，不生成理由。旧版本的非空理由保持可读，不自动覆盖。不能以理由字符串的真假判断跳过状态。
- `planning.learning.skip` 接受省略 `reason` 或空字符串；兼容旧客户端传入的文字，trim 后上限 240 个 UTF-16 单元。不再要求填写理由。前端继续传空字符串时具有相同语义。
- 已完成的小节不能再次跳过。跳过不计为完成，也不计为已开始，但可满足后续小节的前置条件；真正补学并完成后同时移除该小节的跳过键。
- 缺少新字段的旧进度仍按现有恢复规则读取；空值跳过与历史理由共存，不需要重写旧文件或丢弃历史记录。

前端生产与读取见 [learning service](../apps/local-ui/src/routes/learning.ts) 与 [progress parser](../apps/local-ui/src/routes/learning-record.ts)，原生桥和落盘见 [PlanningCoordinator](../apps/macos/PlanningCoordinator.swift) 与 [PlanningStore](../apps/macos/PlanningStore.swift)。验收见 [前端跳过测试](../tests/learning-skip.test.mjs) 和 [原生桥集成测试](../tests/planning-coordinator.test.mjs)。
