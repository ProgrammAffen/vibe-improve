import type {GenerationOutput,PlanningJob} from './service';
export type GenerationEntry=GenerationOutput&{id:string;intent:'generate'|'consistency'};
export function mergeGenerationOutput(current:GenerationEntry[],job:PlanningJob):GenerationEntry[]{
 if(!['generate','consistency'].includes(job.intent))return current;
 const merged=current.map(entry=>({...entry}));
 for(const output of job.generationOutput??[]){
  const id=job.id+':'+output.sequence,index=merged.findIndex(entry=>entry.id===id),entry={...output,id,intent:job.intent as 'generate'|'consistency'};
  if(index<0)merged.push(entry);else if(entry.text.startsWith(merged[index].text)&&!(merged[index].state!=='streaming'&&entry.state==='streaming'))merged[index]=entry;
 }
 return merged;
}
