export interface RouteObjective {id:string;description:string}
export interface RouteAssessment {task:string;passCriteria:string[];objectiveIds:string[];mode?:'quantitative'|'qualitative';evaluatorPrompt?:string}
export interface RouteNode {id:string;title:string;objectives:RouteObjective[];prerequisites:string[];estimatedMinutes:number;assessment?:RouteAssessment;activities?:string[]}
export interface RouteChapter {id:string;title:string;nodes:RouteNode[];stageGoal?:string}
export interface RouteDocument {format:'vibe-improve.route';schemaVersion:1|2;id:string;revision:number;title:string;locale:'zh-CN'|'en';sourceLanguage:'zh-CN'|'en';chapters:RouteChapter[]}
export const MAX_ROUTE_BYTES:number;
export const MAX_ROUTE_DEPTH:number;
export const MAX_ROUTE_NODES:number;
export function parseRoute(text:string):RouteDocument;
export function parseBoundedJSON(text:string):unknown;
export function validateRoute(value:unknown):RouteDocument;
export function routeIssues(value:unknown):{path:string;code:string}[];
export function summarizeRoute(route:RouteDocument):{chapters:number;nodes:number};
