import type {RouteDocument, RouteNode} from './route-validation.mjs';
export function isRequiredLesson(node: RouteNode): boolean;
export function learningPrerequisiteIds(route: RouteDocument, nodeId: string): string[];
export function learningProgressSummary(nodes: RouteNode[], completedNodeIds: ReadonlySet<string>, masteredNodeIds?: ReadonlySet<string>): {total:number;completed:number;optionalOnly:boolean};
