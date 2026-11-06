import type {RouteDocument,RouteChapter,RouteNode} from './route-validation.mjs';
import type {PlanningTarget} from './planning.mjs';
export interface RoutePosition {target:PlanningTarget;chapterIndex:number;nodeIndex:number|null;number:string}
export function routeOutline(route:RouteDocument):{chapter:RouteChapter;number:string;lessons:{node:RouteNode;number:string}[]}[];
export function routeTargetPosition(route:RouteDocument|undefined,target:PlanningTarget):RoutePosition|null;
export function routeMoveProblem(route:RouteDocument,source:PlanningTarget,destination:PlanningTarget,placement?:'before'|'after'):'unavailable'|'chapter-only'|'self'|'full'|'same-position'|null;
export function moveRouteItem(route:RouteDocument,source:PlanningTarget,destination:PlanningTarget,placement?:'before'|'after'):RouteDocument;
export function moveRouteItemBy(route:RouteDocument,source:PlanningTarget,offset:-1|1):RouteDocument;
