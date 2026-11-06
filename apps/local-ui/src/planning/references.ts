import type {PlanningTarget} from '../../../../packages/domain/planning.mjs';
import type {RouteDocument} from '../../../../packages/domain/route-validation.mjs';
import {translate,type Language} from '../i18n';
import {routeTargetPosition} from '../../../../packages/domain/route-order.mjs';

export function planningTargetLabel(route:RouteDocument|undefined,target:PlanningTarget,language:Language){
 const position=routeTargetPosition(route,target),chapter=position?route!.chapters[position.chapterIndex]:undefined;
 if(!chapter)return target.nodeId&&route?.chapters.some(ch=>ch.id===target.chapterId)?translate(language,'已移除的小章','Removed lesson'):translate(language,'已移除的章节','Removed chapter');
 if(target.nodeId)return `${position!.number} ${chapter.nodes[position!.nodeIndex!].title||translate(language,'新小章节','New lesson')}`;
 return `${position!.number} ${chapter.title||translate(language,'新大章节','New chapter')}`;
}
