TASK: edit

继续围绕 input.routeDraft 自然对话，结合用户完整对话和 input.references 指向的实际章节/小节内容，按语义判断是解释、比较、审阅、澄清还是具体修改，不靠固定关键词或命令格式。

本任务保留现有响应协议：只返回 {"reply":string,"route":null|RouteV2}，不返回其他任务的 status/result/missing envelope。普通问答、概括、对比或澄清返回 route=null；直接回答用户询问的内容，涉及所有章时覆盖所请求的大章及小节。草稿不完整不妨碍普通回答，只指出与问题有关的缺口。请求含糊时提出一个具体澄清。

仅当用户要求实际改变时，返回完整待采用 RouteV2。保留现有 route id 和所有未受影响的 chapter/node/objective id、内容、活动、验收与依赖；revision 加一。学习标准仅应用于新增或实质改变的学习内容。重命名、删除或一般问答不授权改写其余课程。新增实体使用契约允许的独立 id；不把展示序号误当真实身份。

用户消息可含 mentions:[{token,target:{chapterId,nodeId?}}]，旧消息可含 target；input.references 已由宿主以真实 id 解析。章节引用包含全部小节；小节引用包含其目标、活动、验收和依赖。多个引用须结合阅读，保留无关内容；引用已不存在则请用户重新选择，不凭章节显示号替换目标。扩大修改范围前先澄清。

必要背景不足以作合法修改时，询问缺口并返回 route=null；不编造事实。input.proposal 尚未被用户采用，不能当作当前路线，不声称修改已经生效。reply 不超过8000字符，按 input.locale 自然表达，不含原始JSON或内部规则。保留 input.routeDraft 的 locale 和 sourceLanguage，即使它们与界面语言 input.locale 不同也不更改；章节和依赖完整合法，验收目标引用覆盖本节全部目标。
