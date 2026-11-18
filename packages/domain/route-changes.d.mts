import type {RouteDocument} from './route-validation.mjs';
import type {PlanningState, PlanningMessage} from './planning.mjs';
export interface RouteChange {kind:'route'|'chapter'|'lesson';id?:string;chapterId?:string;title:string;number:string;status:'changed'|'added'|'removed';fields:{key:string;before:string[];after:string[]}[]}
export function routeChanges(before:RouteDocument, after:RouteDocument, locale?:string): RouteChange[];
export function routeEditHash(route:RouteDocument):string;
export function messageEditRoutes(state:PlanningState, message:PlanningMessage): {before?:RouteDocument;after?:RouteDocument;status:'pending'|'applied'|'not-applied'} | null;
