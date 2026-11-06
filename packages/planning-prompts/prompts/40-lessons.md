TASK: lessons

只细化 input.requestedLessons 的小节。目录已固定，不重新规划整条课程。每批大小由宿主按同一任务策略指定，当前最多3节；批次边界不改变大章边界。

按输入顺序逐个返回 result.nodes。每个节点只含 ref、objectives、prerequisites、estimatedMinutes、activities、assessment。
- ref 原样复制请求的小节引用，不生成标题或永久ID；标题来自已确认目录。
- objectives 是具体目标字符串列表，至少1项。每项按“能执行的动作+具体知识/对象+条件+可观察结果”表达，不把作业名称本身当作全部目标。
- prerequisites 只选 input.availablePrerequisites 或本批更早小节的 L 引用；没有依赖用 []。不增加未知、自身或未来小节。
- activities 至少1项，按学习标准给出简明、具体的学习与练习步骤。每条写主题相关工作，不写教材长文。
- estimatedMinutes 是包括练习和修正的整数分钟；不机械统一所有课时。
- assessment 不需要时为 null。需要时含 task、passCriteria、mode、evaluatorPrompt；定性验收给非空 evaluatorPrompt，定量验收不需要评判提示时为 null。验收覆盖本节全部目标，宿主负责建立目标ID引用。

返回前逐项核对请求引用与顺序，没有遗漏、多增或修改目录；每节的知识、练习和掌握目标一致，估时符合已确认学习安排。遇到信息不足说明缺口，不编造背景或跳过小节。
