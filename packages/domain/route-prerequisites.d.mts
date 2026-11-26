import type {RouteDocument} from './route-validation.mjs';

export type RoutePrerequisiteProblem = 'self'|'cycle'|'limit'|'missing';
export interface RoutePrerequisiteOption {
 value:string;
 number:string;
 title:string;
 selected:boolean;
 disabled:boolean;
 problem:RoutePrerequisiteProblem|null;
}
export const MAX_ROUTE_PREREQUISITES:number;
export function routePrerequisiteOptions(route:RouteDocument,nodeId:string):RoutePrerequisiteOption[];
export function setRoutePrerequisites(route:RouteDocument,nodeId:string,values:readonly string[]):RouteDocument;
