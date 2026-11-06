import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {moveRouteItem,moveRouteItemBy,routeMoveProblem,routeOutline,routeTargetPosition} from '../packages/domain/route-order.mjs';
import {planningMentionToken,refreshPlanningMentions,resolvePlanningMentions} from '../packages/domain/planning-references.mjs';
import {createPlanning,saveEditor,undoEditor,redoEditor,validatePlanning} from '../packages/domain/planning.mjs';

const project='proj_12345678-1234-4234-8234-123456789abc';
function route(){return{format:'vibe-improve.route',schemaVersion:2,id:'route_move',revision:1,title:'Synthetic movement route',locale:'en',sourceLanguage:'en',chapters:['a','b','c'].map((id,ci)=>({id:'ch_'+id,title:'Chapter '+id,stageGoal:'Apply concepts independently.',nodes:Array.from({length:3},(_,ni)=>({id:`node_${ci+1}_${ni+1}`,title:'Lesson '+id+(ni+1),objectives:[{id:`objective_${id}_${ni+1}`,description:'Explain and apply the concept.'}],prerequisites:ni?[`node_${ci+1}_${ni}`]:[],estimatedMinutes:30,activities:['Read a worked example.','Practice independently.']}))}))}}
const chapter=id=>({chapterId:'ch_'+id}),lesson=(id,n)=>({chapterId:'ch_'+id,nodeId:`node_${'abc'.indexOf(id)+1}_${n}`});
const order=route=>route.chapters.map(ch=>[ch.id,ch.nodes.map(n=>n.id)]);
const contents=route=>Object.fromEntries(route.chapters.flatMap(ch=>ch.nodes.map(n=>[n.id,n])));
function numbering(value){routeOutline(value).forEach((entry,ci)=>{assert.equal(entry.number,String(ci+1).padStart(2,'0'));entry.lessons.forEach((n,ni)=>{assert.equal(n.number,`${ci+1}.${ni+1}`);assert.equal(routeTargetPosition(value,{chapterId:entry.chapter.id,nodeId:n.node.id}).number,n.number)})})}

test('up and down always rebuild numbers from array order, independent of persistent IDs',()=>{
 const original=route(),snapshot=structuredClone(original),oldContents=contents(original);
 let next=moveRouteItemBy(original,lesson('a',3),-1);assert.deepEqual(next.chapters[0].nodes.map(n=>n.id),['node_1_1','node_1_3','node_1_2']);numbering(next);
 next=moveRouteItemBy(next,lesson('a',3),-1);assert.deepEqual(next.chapters[0].nodes.map(n=>n.id),['node_1_3','node_1_1','node_1_2']);assert.equal(routeTargetPosition(next,lesson('a',3)).number,'1.1');numbering(next);
 next=moveRouteItemBy(next,chapter('c'),-1);next=moveRouteItemBy(next,chapter('c'),-1);assert.deepEqual(next.chapters.map(ch=>ch.id),['ch_c','ch_a','ch_b']);assert.equal(routeTargetPosition(next,lesson('a',3)).number,'2.1');numbering(next);
 next=moveRouteItemBy(next,chapter('c'),1);assert.equal(routeTargetPosition(next,lesson('c',1)).number,'2.1');numbering(next);
 assert.deepEqual(original,snapshot);assert.deepEqual(contents(next),oldContents);
 assert.equal(moveRouteItemBy(original,chapter('a'),-1),original);assert.equal(moveRouteItemBy(original,lesson('c',3),1),original);
});

test('move to chapter inserts a lesson first; move to lesson inserts after across either direction',()=>{
 const original=route();let next=moveRouteItem(original,lesson('a',3),chapter('b'));
 assert.deepEqual(next.chapters[1].nodes.map(n=>n.id),['node_1_3','node_2_1','node_2_2','node_2_3']);assert.deepEqual(next.chapters[0].nodes.map(n=>n.id),['node_1_1','node_1_2']);numbering(next);
 next=moveRouteItem(next,lesson('a',3),lesson('c',2));assert.deepEqual(next.chapters[2].nodes.map(n=>n.id),['node_3_1','node_3_2','node_1_3','node_3_3']);assert.equal(routeTargetPosition(next,lesson('a',3)).number,'3.3');numbering(next);
 next=moveRouteItem(next,lesson('a',3),lesson('a',1));assert.deepEqual(next.chapters[0].nodes.map(n=>n.id),['node_1_1','node_1_3','node_1_2']);numbering(next);
 next.chapters[1].nodes=[];next=moveRouteItem(next,lesson('a',3),chapter('b'));assert.equal(next.chapters[1].nodes[0].id,'node_1_3');numbering(next);
});

test('chapters only move after chapters; no-op and self destinations do not create edits',()=>{
 let value=route();assert.equal(routeMoveProblem(value,chapter('a'),lesson('b',1)),'chapter-only');assert.throws(()=>moveRouteItem(value,chapter('a'),lesson('b',1)),/ROUTE_MOVE_CHAPTER_ONLY/);
 for(const [source,target] of [[chapter('a'),chapter('a')],[chapter('b'),chapter('a')],[lesson('a',1),chapter('a')],[lesson('a',2),lesson('a',1)]])assert.equal(moveRouteItem(value,source,target),value);
 value=moveRouteItem(value,chapter('a'),chapter('c'));assert.deepEqual(value.chapters.map(ch=>ch.id),['ch_b','ch_c','ch_a']);numbering(value);
 value=moveRouteItem(value,chapter('a'),chapter('b'));assert.deepEqual(value.chapters.map(ch=>ch.id),['ch_b','ch_a','ch_c']);numbering(value);
 assert.throws(()=>moveRouteItem(value,{chapterId:'missing'},chapter('b')),/ROUTE_MOVE_UNAVAILABLE/);
 assert.throws(()=>moveRouteItemBy(value,chapter('a'),2),/ROUTE_MOVE_UNAVAILABLE/);
});

test('full chapters block incoming lessons but allow reordering inside them',()=>{
 const value=route();value.chapters[1].nodes=Array.from({length:64},(_,i)=>({...structuredClone(value.chapters[1].nodes[0]),id:'full_'+i,prerequisites:[]}));
 assert.equal(routeMoveProblem(value,lesson('a',1),chapter('b')),'full');assert.throws(()=>moveRouteItem(value,lesson('a',1),chapter('b')),/ROUTE_MOVE_FULL/);
 const next=moveRouteItem(value,{chapterId:'ch_b',nodeId:'full_63'},chapter('b'));assert.equal(next.chapters[1].nodes.length,64);assert.equal(next.chapters[1].nodes[0].id,'full_63');numbering(next);
});

test('every source/destination pair retains contents, valid indices and stable IDs',()=>{
 const value=route(),targets=value.chapters.flatMap(ch=>[{chapterId:ch.id},...ch.nodes.map(n=>({chapterId:ch.id,nodeId:n.id}))]);
 for(const source of targets)for(const target of targets){if(routeMoveProblem(value,source,target))continue;const next=moveRouteItem(value,source,target);numbering(next);assert.deepEqual(contents(next),contents(value));assert.equal(next.chapters.length,value.chapters.length);assert.equal(next.chapters.flatMap(c=>c.nodes).length,9)}
 let next=value;for(let i=0;i<120;i++){const from=targets[i*7%targets.length],to=targets[(i*11+3)%targets.length];if(!routeMoveProblem(next,from,to))next=moveRouteItem(next,from,to);numbering(next);assert.deepEqual(contents(next),contents(value))}
});

test('mixed moves persist and undo/redo recalculate the entire outline',()=>{
 let state=createPlanning(project,'codex','en',route());const original=structuredClone(state.routeDraft);
 for(const [source,target] of [[lesson('a',3),chapter('b')],[chapter('c'),chapter('a')],[lesson('b',2),lesson('a',1)]]){const next=moveRouteItem(state.routeDraft,source,target);state=saveEditor(state,next,state.revision);numbering(state.routeDraft)}
 const final=structuredClone(state.routeDraft);state=validatePlanning(JSON.parse(JSON.stringify(state)));
 for(let i=0;i<3;i++){state=undoEditor(state,state.revision);numbering(state.routeDraft)}assert.deepEqual(order(state.routeDraft),order(original));
 for(let i=0;i<3;i++){state=redoEditor(state,state.revision);numbering(state.routeDraft)}assert.deepEqual(order(state.routeDraft),order(final));assert.deepEqual(contents(state.routeDraft),contents(original));
});

test('chat mentions follow the same node across chapters and keep each binding when numbers swap',()=>{
 const value=route(),bindings=[{target:lesson('a',3),token:'@1.3节'},{target:lesson('b',1),token:'@2.1节'},{target:chapter('a'),token:'@第1章'}],text=bindings.map(m=>m.token).join(' ');
 let next=moveRouteItem(value,lesson('a',3),chapter('b'));next=moveRouteItem(next,chapter('a'),chapter('c'));
 const refreshed=refreshPlanningMentions(next,text,bindings,'zh-CN');assert.equal(refreshed.text,'@1.1节 @1.2节 @第3章');assert.deepEqual(refreshed.mentions[0].target,{chapterId:'ch_b',nodeId:'node_1_3'});assert.equal(bindings[0].target.chapterId,'ch_a');assert.deepEqual(resolvePlanningMentions(next,refreshed.text,refreshed.mentions),refreshed.mentions);
 assert.equal(planningMentionToken(next,lesson('a',3),'en'),'@Lesson1.1');const removed=structuredClone(next);removed.chapters[0].nodes.shift();assert.throws(()=>resolvePlanningMentions(removed,'@1.3节',bindings),/PLANNING_TARGET_UNAVAILABLE/);
});

test('editor details, outline and move tree display one consistently computed set of numbers',async()=>{
 const dir=await mkdtemp(join(await mkdir(resolve('tmp/checks/route-movement-2026-11-05'),{recursive:true}).then(()=>resolve('tmp/checks/route-movement-2026-11-05')),'ui-')),bundle=join(dir,'ui.mjs');
 await build({stdin:{contents:`export {RouteEditorSurface} from './apps/local-ui/src/components/RouteEditor';export {default as RouteMoveDialog} from './apps/local-ui/src/components/RouteMoveDialog';export {PlanningMessages} from './apps/local-ui/src/components/PlanningConversation';export {renderToStaticMarkup} from 'react-dom/server';export {createElement} from 'react';`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'node',format:'esm',packages:'external',loader:{'.css':'empty'},define:{'import.meta.env.BASE_URL':'"/vibe-improve/"'},outfile:bundle,logLevel:'silent'});
 const {RouteEditorSurface,RouteMoveDialog,PlanningMessages,renderToStaticMarkup,createElement}=await import(pathToFileURL(bundle).href);
 const next=moveRouteItemBy(moveRouteItemBy(route(),lesson('a',3),-1),lesson('a',3),-1),state=createPlanning(project,'codex','en',next);
 for(const language of ['zh-CN','en']){
  const html=renderToStaticMarkup(createElement(RouteEditorSurface,{language,state,route:state.routeDraft}));assert.deepEqual([...html.matchAll(/class="route-outline-lesson-number">([^<]+)/g)].map(m=>m[1]),['1.1','1.2','1.3']);
  const tree=renderToStaticMarkup(createElement(RouteMoveDialog,{route:next,source:lesson('a',3),language,busy:false}));assert.equal((tree.match(/role="treeitem"/g)??[]).length,12);assert.match(tree,/data-move-node="node_1_3"/);assert.match(tree,/aria-level="2"/);
 }
 const history=[{id:'old',role:'user',text:'Change @1.3节',createdAt:'2026-11-05T00:00:00.000Z',mentions:[{target:lesson('a',3),token:'@1.3节'}]}];
 const html=renderToStaticMarkup(createElement(PlanningMessages,{messages:history,providerId:'codex',language:'zh-CN',route:next}));assert.match(html,/@1\.1节/);assert.doesNotMatch(html,/@1\.3节/);assert.equal(history[0].text,'Change @1.3节');
});
