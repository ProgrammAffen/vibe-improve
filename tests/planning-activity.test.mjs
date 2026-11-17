import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

test('CLI activity accepts only bounded metadata and renders localized live or stalled state',async()=>{
 await mkdir('tmp/checks/planning-activity',{recursive:true});const dir=await mkdtemp('tmp/checks/planning-activity/run-'),file=resolve(dir,'test.mjs');
 await build({stdin:{contents:`export {parsePlanningActivity,planningMessage,planningError,planningProgress,planningFailure} from './apps/local-ui/src/planning/service.ts';export {default as Panel} from './apps/local-ui/src/components/PlanningActivityPanel.tsx';export {renderToStaticMarkup} from 'react-dom/server';export {createElement} from 'react';`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'node',format:'esm',packages:'external',outfile:file});
 const {parsePlanningActivity,planningMessage,planningError,planningProgress,planningFailure,Panel,renderToStaticMarkup,createElement}=await import(pathToFileURL(file).href);
 const outcome=planningFailure({errorCode:'PLANNING_NEEDS_INPUT',userReply:'每周大概能安排多久？'});
 assert.equal(outcome.message,'PLANNING_NEEDS_INPUT');assert.equal(planningError(outcome),'PLANNING_NEEDS_INPUT');assert.equal(planningMessage(outcome,'zh-CN'),'每周大概能安排多久？');
 assert.match(planningMessage(new Error('PLANNING_CANNOT_COMPLETE'),'en'),/cannot complete/);
 assert.equal(planningError(new Error('PLANNING_AGENT_ROUTE_ENCODING')),'PLANNING_AGENT_ROUTE_ENCODING');
 assert.match(planningMessage(new Error('PLANNING_AGENT_ROUTE_ENCODING'),'zh-CN'),/格式不完整/);
 assert.match(planningMessage(new Error('PLANNING_AGENT_ROUTE_ENCODING'),'en'),/incomplete route format/);
 assert.equal(planningError(new Error('PLANNING_AGENT_ROUTE_MISSING')),'PLANNING_AGENT_ROUTE_MISSING');
 assert.match(planningMessage(new Error('PLANNING_AGENT_ROUTE_MISSING'),'zh-CN'),/未提交路线/);
 assert.match(planningMessage(new Error('PLANNING_AGENT_ROUTE_MISSING'),'en'),/without a route/);
 assert.match(planningProgress({diagnostic:{stage:'generating',durationMs:15000,completedChapters:3,chapterCount:8}},'zh-CN'),/已完成 3\/8 章/);
 assert.match(planningProgress({diagnostic:{stage:'thinking',durationMs:15000,completedChapters:3,chapterCount:8}},'en'),/3\/8 chapters ready/);
 assert.match(planningProgress({intent:'generate',state:'pending',generationOutput:[{kind:'review',state:'streaming'}],diagnostic:{stage:'thinking',durationMs:0}},'en'),/Reviewing route content/);
 assert.match(planningProgress({intent:'generate',state:'pending',generationOutput:[{kind:'revision',state:'streaming'}],diagnostic:{stage:'generating',durationMs:0}},'zh-CN'),/正在修正章节/);
 assert.match(planningProgress({diagnostic:{stage:'generating',durationMs:1_810_000}},'en'),/1810s/);
 assert.doesNotMatch(planningProgress({diagnostic:{stage:'generating',durationMs:0,completedChapters:9,chapterCount:8}},'en'),/chapters ready/);
 const saved={stage:'generating',durationMs:0,completedChapters:0,chapterCount:2,completedLessons:3,lessonCount:6};
 assert.match(planningProgress({diagnostic:saved},'zh-CN'),/已保存 3 \/ 6 节草稿 · 正在生成内容/);
 assert.match(planningProgress({diagnostic:{...saved,stage:'reviewing',completedLessons:6}},'en'),/6 \/ 6 lesson drafts saved · Reviewing route content/);
 assert.doesNotMatch(planningProgress({diagnostic:{...saved,completedLessons:7}},'en'),/lesson drafts saved/);
 const sample={durationMs:60000,lastActivityMs:59000,thinkingCharacters:12345,outputCharacters:456,events:[{sequence:1,stage:'thinking',atMs:59000,thinkingCharacters:12345,outputCharacters:456}]};
 assert.deepEqual(parsePlanningActivity(sample),sample);assert.equal(parsePlanningActivity(undefined),undefined);
 for(const [stage,caption] of [['reviewing','Reviewing route content'],['revising','Revising lessons']]){
  const qualityActivity={...sample,events:[{...sample.events[0],stage}]};
  assert.deepEqual(parsePlanningActivity(qualityActivity),qualityActivity);
  assert.match(renderToStaticMarkup(createElement(Panel,{activity:qualityActivity,busy:true,language:'en'})),new RegExp(caption));
 }
 const longRun={...sample,durationMs:90_000_000,lastActivityMs:89_999_000,events:[{...sample.events[0],atMs:89_999_000}]};
 assert.deepEqual(parsePlanningActivity(longRun),longRun);
 assert.throws(()=>parsePlanningActivity({...sample,durationMs:Number.MAX_SAFE_INTEGER+1}),/PLANNING_RESPONSE_INVALID/);
 const idleFailure=planningFailure({errorCode:'PLANNING_AGENT_TIMEOUT',diagnostic:{stage:'idle_timeout'}});
 assert.match(planningMessage(idleFailure,'zh-CN'),/连续 3 分钟没有输出/);
 assert.match(planningMessage(idleFailure,'en'),/3 minutes without agent output/);
 for(const bad of [{...sample,text:'SECRET'},{...sample,lastActivityMs:60001},{...sample,events:Array(61).fill(sample.events[0])},{...sample,thinkingCharacters:-1},{...sample,events:[{...sample.events[0],stage:'SECRET'}]},{...sample,events:[{...sample.events[0],text:'SECRET'}]},{...sample,events:[sample.events[0],sample.events[0]]}])assert.throws(()=>parsePlanningActivity(bad),/PLANNING_RESPONSE_INVALID/);
 const zh=renderToStaticMarkup(createElement(Panel,{activity:sample,busy:true,language:'zh-CN'}));assert.match(zh,/12,345/);assert.match(zh,/刚刚收到活动/);assert.match(zh,/CLI 实时活动/);
 const stale=renderToStaticMarkup(createElement(Panel,{activity:{...sample,lastActivityMs:0},busy:true,language:'en'}));assert.match(stale,/60s since last activity/);assert.match(stale,/data-stale="true"/);
 const ended=renderToStaticMarkup(createElement(Panel,{activity:sample,busy:false,language:'en'}));assert.match(ended,/Request ended/);assert.doesNotMatch(ended,/Activity just received/);
});
