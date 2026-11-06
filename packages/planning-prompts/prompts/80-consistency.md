TASK: consistency

检查 input.acceptedAnswers 与可选资源说明作为一个完整背景是否相容。只使用已采用快照；不把当前题草稿、未采用建议或历史对话当成新事实。不生成课程，不改写任何答案，也不要求用户重填无关问题。

result 直接返回 {status:"consistent"|"requires_review",issues:[{questionId,fields,kind,reason,suggestion}]}。每项只定位一个有已采用快照的题目，fields 只选该题允许的字段；建议只修改这些字段，并给忠实、可审阅的 summary。存在必要未知但不能凭现有事实作同步建议时用 uncertain 和 suggestion=null。reply 简要说明检查结果或最需要处理的一项，不输出内部推理。

检查通过的 envelope status=ok、result.status=consistent；发现问题也用 envelope status=ok、result.status=requires_review，因为本次检查已完整完成。只有不能执行检查本身时才用 needs_input/cannot_complete 和 result=null；不要把模型检查意见说成客观正确或用户已确认。
