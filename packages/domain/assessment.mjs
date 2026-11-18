export const MAX_ASSESSMENT_ANSWER_LENGTH = 64_000;

export function assessmentAnswer(assessment, locale = 'zh-CN') {
  if (typeof assessment.answer === 'string') return assessment.answer;
  const criteria = (assessment.passCriteria ?? []).join('\n');
  const guidance = assessment.evaluatorPrompt ?? '';
  if (!guidance.trim()) return criteria;
  if (!criteria.trim()) return guidance;
  return locale === 'en'
    ? `Grading criteria\n${criteria}\n\nReference answer and guidance\n${guidance}`
    : `评判标准\n${criteria}\n\n参考答案与评判依据\n${guidance}`;
}

export function withAssessmentAnswer(assessment, answer) {
  return {task: assessment.task, answer, objectiveIds: [...assessment.objectiveIds]};
}
