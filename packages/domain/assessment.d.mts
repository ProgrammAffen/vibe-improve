import type {RouteAssessment} from './route-validation.mjs';
export const MAX_ASSESSMENT_ANSWER_LENGTH: number;
export function assessmentAnswer(assessment: RouteAssessment, locale?: string): string;
export function withAssessmentAnswer(assessment: RouteAssessment, answer: string): RouteAssessment;
