import type {JSONContent} from '@tiptap/core';
import type {AgentOptions} from '../../../../packages/domain/planning.mjs';

export type LessonIdentity = {projectId: string; routeId: string; nodeId: string};
export type LessonSource = {quote: string; page?: number; startMs?: number; endMs?: number};
export type LessonMessage = {id: string; role: 'user' | 'assistant'; text: string; status?: 'pending' | 'complete' | 'incomplete'};
export type LessonRecord = {
  id: string;
  kind: 'note' | 'question';
  title: string;
  content?: JSONContent;
  source?: LessonSource;
  references?: {blockId: string; source: LessonSource}[];
  messages: LessonMessage[];
  collapsed: boolean;
};
export type LessonBlock = {
  id: string;
  kind: 'text' | 'math' | 'resource' | 'link';
  content?: JSONContent;
  latex?: string;
  resource?: {id: string; version: string};
  url?: string;
  title?: string;
  collapsed: boolean;
  records: LessonRecord[];
};
export type LessonWorkspace = LessonIdentity & {schemaVersion: 1; revision: number; blocks: LessonBlock[]};
export type LessonAgentJob = {
  id: string;
  state: 'pending' | 'completed' | 'failed' | 'cancelled';
  text: string;
  editText?: string;
  stage?: string;
  errorCode?: string;
};
export type LessonAgentInput = LessonIdentity & {
  expectedRevision: number;
  blockId: string;
  recordId: string;
  locale: 'zh-CN' | 'en';
  agentOptions: AgentOptions;
  intent: 'ask' | 'rewrite';
  targetRecordId?: string;
};
