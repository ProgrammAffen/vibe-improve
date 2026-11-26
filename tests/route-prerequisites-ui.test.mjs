import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {createPlanning,saveEditor,confirmRoute,validatePlanning,undoEditor,redoEditor} from '../packages/domain/planning.mjs';

await mkdir('tmp/checks/route-prerequisites-ui',{recursive:true});
const dir=await mkdtemp('tmp/checks/route-prerequisites-ui/run-'),outfile=resolve(dir,'ui.mjs');
// Observe the actual editor-to-select boundary while rendering the real shared
// control. Its onChange below is RouteEditorSurface's production callback;
// dependency mutation and persistence are never reconstructed in the test.
await build({stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`
 export {RouteEditorSurface} from './apps/local-ui/src/components/RouteEditor.tsx';
 export {AdventureMap} from './apps/local-ui/src/components/AdventureMap.tsx';
 export {capturedSelects} from './apps/local-ui/src/components/GameSelect';
 export {createElement} from 'react';
 export {renderToStaticMarkup} from 'react-dom/server';
`},bundle:true,platform:'node',format:'esm',packages:'external',loader:{'.css':'empty'},
 define:{'import.meta.env.BASE_URL':'"/vibe-improve/"'},outfile,plugins:[{
  name:'observe-real-select-props',setup(plugin){
   plugin.onResolve({filter:/\/GameSelect$/},()=>({path:'select-observer',namespace:'test-select-observer'}));
   plugin.onLoad({filter:/.*/,namespace:'test-select-observer'},()=>({resolveDir:process.cwd(),loader:'tsx',contents:`
    import React from 'react';
    import RealGameSelect from ${JSON.stringify(resolve('apps/local-ui/src/components/GameSelect.tsx'))};
    export const capturedSelects=[];
    export default function ObservedGameSelect(props){capturedSelects.push(props);return <RealGameSelect {...props}/>;}
   `}));
  },
 }]});
const {RouteEditorSurface,AdventureMap,capturedSelects,createElement,renderToStaticMarkup}=await import(pathToFileURL(outfile));
const project='proj_12345678-1234-4234-8234-123456789abc',no=()=>{};
const lesson=(id,title,prerequisites=[])=>({id,title,objectives:[{id:'goal_'+id,description:'Explain '+title}],prerequisites,estimatedMinutes:30});
const route=()=>({format:'vibe-improve.route',schemaVersion:2,id:'prerequisite-ui',revision:1,title:'Synthetic prerequisite selection',locale:'en',sourceLanguage:'en',chapters:[
 {id:'first',title:'First chapter',stageGoal:'Understand foundations.',nodes:[lesson('target','Destination'),lesson('foundationA','Foundation A'),lesson('dependent','Dependent lesson',['target'])]},
 {id:'second',title:'Second chapter',stageGoal:'Use the foundations.',nodes:[lesson('foundationB','Foundation B')]},
]});
function editorHarness(language='en',studiedNodeIds=new Set()){
 let state=createPlanning(project,null,language,route()),draft=state.routeDraft,changes=0;
 function save(){state=saveEditor(state,draft,state.revision);draft=state.routeDraft}
 return {
  get state(){return state},get draft(){return draft},get changes(){return changes},save,
  reopen(){state=validatePlanning(JSON.parse(JSON.stringify(state)));draft=state.routeDraft},
  undo(){state=undoEditor(state,state.revision);draft=state.routeDraft},
  redo(){state=redoEditor(state,state.revision);draft=state.routeDraft},
  confirm(){state=confirmRoute(state,state.revision);draft=state.routeDraft},
  render(){
   capturedSelects.length=0;
   const html=renderToStaticMarkup(createElement(RouteEditorSurface,{state,route:draft,language,studiedNodeIds,
    onRoute:value=>{draft=value;changes++},onSave:save,onConfirm:no,onSend:()=>false,
    onCancel:no,onApply:no,onDiscard:no,onUndo:no,onPrevious:no,onHome:no}));
   const control=capturedSelects.find(select=>select['aria-label']===(language==='en'?'Prerequisites':'前置章节'));
   assert.ok(control,'The actual editor should render its prerequisite selector');
   return {html,control};
  },
 };
}
function mapStatus(value,nodeTitle,completedNodeIds=new Set(),skippedReasons=new Map(),masteredNodeIds=new Set()){
 const html=renderToStaticMarkup(createElement(AdventureMap,{route:value,language:'en',onStartLesson:no,onEdit:no,onBack:no,completedNodeIds,skippedReasons,masteredNodeIds}));
 const marker=[...html.matchAll(/<button\b[^>]*>/g)].map(match=>match[0]).find(button=>button.includes(`aria-label="${nodeTitle} · `));
 assert.ok(marker,'The selected lesson should be present on this synthetic map page');
 return /data-status="([^"]+)"/.exec(marker)?.[1];
}

test('the real editor exposes a multi-select inside other settings and its callback updates multiple prerequisites',()=>{
 for(const language of ['zh-CN','en']){
  const editor=editorHarness(language),{html,control}=editor.render();
  const settings=/<details\b[^>]*data-route-section="settings"[^>]*>([\s\S]*?)<\/details>/.exec(html)?.[1];
  assert.ok(settings);assert.match(settings,language==='en'?/aria-label="Prerequisites"/:/aria-label="前置章节"/);
  assert.match(settings,language==='en'?/class="game-select-value">No prerequisites<\//:/class="game-select-value">无前置章节<\//,'An empty selection must have a visible placeholder');
  assert.equal(control.multiple,true);assert.equal(Boolean(control.disabled),false);assert.deepEqual(control.value,[]);
  assert.equal(control.options.some(option=>option.value==='target'),false,'Do not offer this lesson as its own prerequisite');
  assert.equal(control.options.find(option=>option.value==='dependent').disabled,true,'A dependent cannot be selected as a prerequisite');
  assert.equal(Boolean(control.options.find(option=>option.value==='foundationB').disabled),false,'An independent lesson from another chapter remains selectable');
  control.onChange(['foundationA']);
  const afterOne=editor.render().control;assert.deepEqual(afterOne.value,['foundationA']);
  afterOne.onChange(['foundationA','foundationB']);
  assert.equal(editor.changes,2);assert.deepEqual(editor.render().control.value,['foundationA','foundationB']);
 }
});

test('a manual multi-selection survives save reopen undo redo and drives the actual map lock state',()=>{
 const editor=editorHarness();
 assert.equal(mapStatus(editor.draft,'Destination'),'current');
 editor.render().control.onChange(['foundationA','foundationB']);
 editor.save();editor.confirm();editor.reopen();
 assert.deepEqual(editor.render().control.value,['foundationA','foundationB']);
 assert.equal(mapStatus(editor.state.routeDraft,'Destination'),'locked');
 assert.equal(mapStatus(editor.state.routeDraft,'Destination',new Set(['foundationA'])),'locked','One of two prerequisites is still incomplete');
 const handled=new Set(['foundationA']);
 assert.equal(mapStatus(editor.state.routeDraft,'Destination',handled,new Map([['foundationB','']])),'locked','Skipping a declared prerequisite leaves the lesson locked');
 assert.equal(mapStatus(editor.state.routeDraft,'Destination',handled,new Map(),new Set(['foundationB'])),'current','A mastered prerequisite unlocks the lesson alongside a completed prerequisite');
 editor.undo();assert.deepEqual(editor.render().control.value,[]);assert.equal(mapStatus(editor.state.routeDraft,'Destination'),'current');
 editor.redo();assert.deepEqual(editor.render().control.value,['foundationA','foundationB']);assert.equal(mapStatus(editor.state.routeDraft,'Destination'),'locked');
 editor.render().control.onChange(['foundationA']);editor.save();editor.reopen();
 assert.deepEqual(editor.render().control.value,['foundationA']);
 assert.equal(mapStatus(editor.state.routeDraft,'Destination',handled),'current','Removing one dependency updates unlocking after the route is saved');
});

test('started lessons expose the same prerequisite values read only and reject callback edits',()=>{
 for(const language of ['zh-CN','en']){
  const editor=editorHarness(language,new Set(['target'])),{html,control}=editor.render();
  assert.equal(control.disabled,true);assert.equal(control.multiple,true);
  assert.match(html,language==='en'?/Learning progress recorded · Read only/:/已有学习进度 · 只读/);
  const before=structuredClone(editor.draft);
  control.onChange(['foundationA','foundationB']);
  assert.equal(editor.changes,0);assert.deepEqual(editor.draft,before);
 }
});
