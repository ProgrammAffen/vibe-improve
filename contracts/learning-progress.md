# 路线学习进度

进度按 `projectId / routeId` 隔离。路线修订与 `progressRevision` 在写入时同时校验；重复记录同一个小节状态不重复递增进度修订。

- `startedNodeIds` 记录已开始的小节，`completedNodeIds` 记录自评完成的小节。
- `masteredNodeIds` 记录用户主动标记为已掌握的小节。`planning.learning.master` 接收与完成操作相同的项目、路线、小节及修订字段。成功后移除当节跳过记录，单独保存掌握状态。已掌握的小节可以重新进入，正式完成后转为完成状态。缺少 `masteredNodeIds` 的存量记录默认为空。
- `skippedReasons` 保留已有存储与桥接字段名，但**键是否存在**才表示已跳过；新跳过使用空字符串，不生成理由。旧版本的非空理由保持可读，不自动覆盖。不能以理由字符串的真假判断跳过状态。
- `planning.learning.skip` 接受省略 `reason` 或空字符串；兼容旧客户端传入的文字，trim 后上限 240 个 UTF-16 单元。不再要求填写理由。前端继续传空字符串时具有相同语义。
- 每个明确指定的前置小节都必须已完成或已掌握。仅开始、未开始和已跳过都不能解锁后续小节，选学小节被选为前置时适用同一条件。已完成或已掌握的小节仍可重看。
- 已完成或已掌握的小节不能再次跳过。跳过不计为完成或已开始，补学完成或标记已掌握后移除跳过键。旧的空值跳过与历史理由均按原记录读取。
- 地图进度按已完成与已掌握的并集计数。路线编辑保护适用于已开始、已完成及已掌握的小节。

前端生产与读取见 [learning service](../apps/local-ui/src/routes/learning.ts) 与 [progress parser](../apps/local-ui/src/routes/learning-record.ts)，原生桥和落盘见 [PlanningCoordinator](../apps/macos/PlanningCoordinator.swift) 与 [PlanningStore](../apps/macos/PlanningStore.swift)。验收见 [前端跳过测试](../tests/learning-skip.test.mjs) 和 [原生桥集成测试](../tests/planning-coordinator.test.mjs)。
