import {canGenerate,canRequestGeneration,needsConsistencyCheck,type GenerationMode,type PlanningState} from '../../../../packages/domain/planning.mjs';
import type {PlanningJob, RouteGenerationPhase} from './service';

export type GenerationStage={phase:RouteGenerationPhase;completed?:number;total?:number};

export function generationStage(job:PlanningJob):GenerationStage {
 const phase=job.generationPhase??'prepare';
 const {completedLessons,lessonCount}=job.diagnostic??{};
 if(lessonCount!==undefined&&completedLessons!==undefined&&Number.isInteger(lessonCount)&&Number.isInteger(completedLessons)&&
  lessonCount>=1&&lessonCount<=512&&completedLessons>=0&&completedLessons<=lessonCount) {
  return {phase,completed:completedLessons,total:lessonCount};
 }
 return {phase};
}

const phaseSteps:Record<RouteGenerationPhase,number>={prepare:0,outline:1,lessons:2,review:3,revision:3,finalize:4,saving:4,complete:4};
export function generationMeter({phase,completed=0,total}:GenerationStage){
 const step=phaseSteps[phase];
 const lessonFraction=phase==='lessons'&&total?completed/total:0;
 return {step,value:phase==='complete'?100:20*(step+lessonFraction)};
}

export async function generateWithConsistency(read:()=>PlanningState|null,request:(intent:'consistency'|'generate',replaceExisting?:boolean,generationMode?:GenerationMode)=>Promise<boolean>,replaceExisting=false,generationMode:GenerationMode='new'):Promise<boolean>{
 const initial=read();
 if(!initial||!canRequestGeneration(initial))return false;
 if(needsConsistencyCheck(initial)&&!await request('consistency'))return false;
 const checked=read();
 if(!checked||!canGenerate(checked))return false;
 return request('generate',replaceExisting,generationMode);
}
