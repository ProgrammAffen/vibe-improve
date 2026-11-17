import type {RouteDocument} from './route-validation.mjs';
export type QuestionId='goal'|'purpose'|'baseline'|'time'|'deadline'|'scope'|'constraints';
export type QuestionStatus='pending'|'current'|'needs-detail'|'awaiting-confirmation'|'complete'|'needs-review';
export interface PlanningMessageEvidence {field:string;messageId:string;quote:string;proposalMessageId?:string;reusedFrom?:QuestionId;acceptanceEventId?:never}
export interface PlanningAcceptanceEvidence {field:string;acceptanceEventId:string;quote:string;messageId?:never;proposalMessageId?:never;reusedFrom?:never}
export type PlanningEvidence=PlanningMessageEvidence|PlanningAcceptanceEvidence;
export interface AcceptedAnswerSnapshot {revision:number;summary:string;fields:Record<string,string>;evidence:PlanningEvidence[]}
export interface ConsistencySuggestion {summary:string;fields:Record<string,string>}
export interface ConsistencyIssue {questionId:QuestionId;fields:string[];kind:'incompatible'|'uncertain';reason:string;suggestion:ConsistencySuggestion|null}
export interface ConsistencyAssessment {status:'consistent'|'requires_review';issues:ConsistencyIssue[]}
export interface BoundConsistencyAssessment {version:string;baseEpoch:number;proposedFactsHash:string;assessment:ConsistencyAssessment}
export interface StoredConsistencyIssue extends ConsistencyIssue {id:string;answerRevision:number;sourceRequestId:string;anchorQuestionId:QuestionId|null}
export interface PlanningConsistency {version:string;status:'dirty'|'consistent'|'requires_review';epoch:number;factsHash:string;issues:StoredConsistencyIssue[];checkedRequestId?:string;anchorQuestionId?:QuestionId|null;anchorRevision?:number|null}
export interface PlanningAnswerEvent {id:string;kind:'suggestion';questionId:QuestionId;answerRevision:number;epoch:number;summary:string;fields:Record<string,string>;createdAt:string;sourceRequestId?:string;issueId?:string}
export interface AnswerConfirmation {kind:'confirm'|'update'|'clarify'|'stale';canAccept:boolean;issues:ConsistencyIssue[];changes:{questionId:QuestionId;before:AcceptedAnswerSnapshot;after:ConsistencySuggestion;reason:string}[]}
export interface PlanningFacts {answers:Partial<Record<QuestionId,{revision:number;summary:string;fields:Record<string,string>}>>;resources:string}
export interface PlanningQuestion {id:QuestionId;status:QuestionStatus;summary:string;fields:Record<string,string>;evidence:PlanningEvidence[];missing:string[];answerProposal?:{summary:string;messageId:string;consistency?:BoundConsistencyAssessment};conversationFrom?:number;acceptedSnapshot?:AcceptedAnswerSnapshot;baselineOptions?:string[]}
export interface PlanningTarget {chapterId:string;nodeId?:string}
export interface PlanningMention {target:PlanningTarget;token:string}
export interface PlanningAttachment {id:string;name:string;kind:'image'|'document'}
export interface PlanningMessage {id:string;role:'user'|'assistant';text:string;createdAt:string;questionId?:QuestionId;target?:PlanningTarget;mentions?:PlanningMention[];provider?:string|null;attachments?:PlanningAttachment[]}
export interface PlanningPending {id:string;kind:'interview'|'generate'|'edit'|'consistency';baseRevision:number;questionId:QuestionId|null;backgroundEpoch?:number;factsHash?:string;prefill?:true}
export interface PlanningProposal {route:RouteDocument;reply:string;baseRevision:number;routeRevision:number}
export interface AgentOptions {model:string|null;effort:string|null}
export type GenerationMode='new'|'resume'|'restart';
export interface ResourceSelection {id:string;version:string}
export interface MaterialLink extends ResourceSelection {kind:'chapter'|'lesson';targetId:string;origin:'ai'|'editor';segmentId?:string}
export interface ResourceSnapshot {provider:string;items:ResourceSelection[]}
export interface GenerationDraft {schemaVersion:1;id:string;revision:number;createdAt:string;updatedAt:string;backgroundEpoch:number;factsHash:string;policyVersion:string;locale:'zh-CN'|'en';baseRouteHash:string;routeId:string;outline:{status:'ok';reply:string;result:{title:string;chapters:{title:string;stageGoal:string;lessons:{title:string;focus:string}[]}[]};missing:[]};chapters:(RouteDocument['chapters'][number]|null)[];revisedLessonIds?:string[]}
export interface GenerationProgress {completed:number;total:number;resumable:boolean;revised?:number}
export interface GenerationRevisionPatch {nodes:RouteDocument['chapters'][number]['nodes'];renamedLessons:string[];materialLinks?:MaterialLink[]}
export interface PlanningState {generationDraft?:GenerationDraft;resources?:string;resourceSnapshot?:ResourceSnapshot;routeMaterials?:{routeId:string;links:MaterialLink[]}[];intakeChanged?:boolean;agentOptions?:AgentOptions;agentChoice?:string;schemaVersion:1;projectId:string;revision:number;step:'intake'|'editor';provider:string|null;locale:'zh-CN'|'en';currentQuestion:QuestionId|null;questions:PlanningQuestion[];messages:PlanningMessage[];routeDraft?:RouteDocument;importedOriginal?:RouteDocument;confirmedRevision?:number;pending?:PlanningPending;proposal?:PlanningProposal;undoRoute?:RouteDocument;history?:{past:RouteDocument[];future:RouteDocument[]};backgroundEpoch?:number;consistency?:PlanningConsistency;answerEvents?:PlanningAnswerEvent[]}
export interface InterviewUpdate {id:QuestionId;fields:Record<string,string>;evidence:PlanningEvidence[];missing:string[];complete:boolean}
export interface InterviewResult {reply:string;summary?:string;updates:InterviewUpdate[];consistency?:ConsistencyAssessment;baselineOptions?:string[]}
export interface ConsistencyCheckResult {reply:string;consistency:ConsistencyAssessment}
export const QUESTION_IDS:readonly QuestionId[];
export const DEFAULT_QUESTION_IDS:readonly QuestionId[];
export const MAX_PLANNING_BYTES:number;
export const CONSISTENCY_VERSION:'answer-consistency.v1';
export function acceptedAnswer(question:PlanningQuestion|undefined):AcceptedAnswerSnapshot|null;
export function planningFacts(state:PlanningState):PlanningFacts;
export function planningFactsHash(state:PlanningState):string;
export function consistencyReady(state:PlanningState):boolean;
export function needsConsistencyCheck(state:PlanningState):boolean;
export function canRequestGeneration(state:PlanningState):boolean;
export function beginConsistencyCheck(state:PlanningState,requestId:string,expectedRevision:number):PlanningState;
export function applyConsistencyCheck(state:PlanningState,result:ConsistencyCheckResult,requestId:string,baseRevision:number,now?:string):PlanningState;
export function acceptConsistencySuggestion(state:PlanningState,issueId:string,expectedRevision:number,now?:string):PlanningState;
export function cancelAnswerDraft(state:PlanningState,questionId:QuestionId,expectedRevision:number):PlanningState;
export function questionText(id:QuestionId,locale:'zh-CN'|'en'):string;
export function questionHelp(id:QuestionId,locale:'zh-CN'|'en'):string;
export function questionLabel(id:QuestionId,locale:'zh-CN'|'en'):string;
export function createPlanning(projectId:string,provider:string|null,locale:'zh-CN'|'en',route?:RouteDocument):PlanningState;
export function validatePlanning(value:unknown):PlanningState;
export function parseInterviewResult(text:string):InterviewResult;
export function canGenerate(state:PlanningState):boolean;
export function validPlanningAttachments(value:unknown):value is PlanningAttachment[];
export function appendUser(state:PlanningState,text:string,messageId:string,requestId:string,expectedRevision:number,now?:string,target?:PlanningTarget|null,mentions?:PlanningMention[]|null,attachments?:PlanningAttachment[]):PlanningState;
export function canPrefillInterview(state:PlanningState):boolean;
export function beginInterviewPrefill(state:PlanningState,requestId:string,expectedRevision:number):PlanningState;
export function validatePlanningTarget(route:RouteDocument,target:PlanningTarget):PlanningTarget;
export function applyInterview(state:PlanningState,result:InterviewResult,requestId:string,baseRevision:number,now?:string):PlanningState;
export function startGeneration(state:PlanningState,requestId:string,expectedRevision:number,replaceExisting?:boolean,generationMode?:GenerationMode,resources?:ResourceSnapshot|null):PlanningState;
export function answerConfirmation(state:PlanningState,id:QuestionId):AnswerConfirmation|null;
export function acceptAnswer(state:PlanningState,id:QuestionId,messageId:string,expectedRevision:number,now?:string):PlanningState;
export function reanswerQuestion(state:PlanningState,id:QuestionId,expectedRevision:number):PlanningState;
export function restartIntake(state:PlanningState,expectedRevision:number):PlanningState;
export function restartIntakeFrom(state:PlanningState,id:QuestionId,expectedRevision:number):PlanningState;
export function questionMessages(state:PlanningState,id:QuestionId):PlanningMessage[];
export function needsGenerationReplacement(state:PlanningState):boolean;
export function setResources(state:PlanningState,text:string,expectedRevision:number):PlanningState;
export function applyGenerated(state:PlanningState,route:RouteDocument,requestId:string,baseRevision:number,revisedLessons?:string[],renamedLessons?:string[],materialLinks?:MaterialLink[]):PlanningState;
export function setRouteMaterial(state:PlanningState,routeId:string,link:MaterialLink,add:boolean,expectedRevision:number):PlanningState;
export function applyEdit(state:PlanningState,result:{reply:string;route?:RouteDocument|null},requestId:string,baseRevision:number,now?:string):PlanningState;
export function applyProposal(state:PlanningState,expectedRevision:number):PlanningState;
export function discardProposal(state:PlanningState,expectedRevision:number):PlanningState;
export function undoEditor(state:PlanningState,expectedRevision:number):PlanningState;
export function redoEditor(state:PlanningState,expectedRevision:number):PlanningState;
export function cancelPlanningRequest(state:PlanningState,requestId:string,expectedRevision:number):PlanningState;
export function recoverPlanning(state:PlanningState,now?:string):PlanningState;
export function focusQuestion(state:PlanningState,id:QuestionId,expectedRevision:number):PlanningState;
export function setProvider(state:PlanningState,provider:string|null,expectedRevision:number,rememberChoice?:boolean):PlanningState;
export function openEditor(state:PlanningState,expectedRevision:number):PlanningState;
export function resetEditor(state:PlanningState,expectedRevision:number):PlanningState;
export function saveEditor(state:PlanningState,route:RouteDocument,expectedRevision:number):PlanningState;
export function importRoute(state:PlanningState,route:RouteDocument,expectedRevision:number):PlanningState;
export function confirmRoute(state:PlanningState,expectedRevision:number):PlanningState;
export function validateEditorDraft(route:unknown):RouteDocument;
export function upgradeRoute(route:RouteDocument):RouteDocument;
export function sameRoute(first:RouteDocument,second:RouteDocument):boolean;
export function assertStudiedRouteUnchanged(previousRoute: RouteDocument | null | undefined, nextRoute: RouteDocument | null | undefined, studiedNodeIds: Iterable<string>): void;
export function reopenIntake(state:PlanningState,expectedRevision:number):PlanningState;
export function removeImportedRoute(state:PlanningState,expectedRevision:number):PlanningState;

export function questionExample(id:QuestionId,locale:'zh-CN'|'en'):string;
export function intakeQuestions(state:PlanningState):PlanningQuestion[];
export function intakeCurrentQuestion(state:PlanningState):QuestionId|null;

export function setAgentOptions(state:PlanningState,options:AgentOptions,expectedRevision:number):PlanningState;

export function generationProgress(state:PlanningState):GenerationProgress|null;
export function saveGenerationProgress(state:PlanningState,progress:Pick<GenerationDraft,'routeId'|'outline'|'chapters'>,requestId:string,baseRevision:number,now?:string):PlanningState;
export function saveGenerationRevision(state:PlanningState,patch:GenerationRevisionPatch|null,requestId:string,baseRevision:number,now?:string):PlanningState;
