import {canGenerate,canRequestGeneration,needsConsistencyCheck,type GenerationMode,type PlanningState} from '../../../../packages/domain/planning.mjs';

export async function generateWithConsistency(read:()=>PlanningState|null,request:(intent:'consistency'|'generate',replaceExisting?:boolean,generationMode?:GenerationMode)=>Promise<boolean>,replaceExisting=false,generationMode:GenerationMode='new'):Promise<boolean>{
 const initial=read();
 if(!initial||!canRequestGeneration(initial))return false;
 if(needsConsistencyCheck(initial)&&!await request('consistency'))return false;
 const checked=read();
 if(!checked||!canGenerate(checked))return false;
 return request('generate',replaceExisting,generationMode);
}
