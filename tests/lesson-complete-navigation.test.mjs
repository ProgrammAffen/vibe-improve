import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile,mkdir,mkdtemp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import ts from 'typescript';
import {build} from 'esbuild';

// Exercise the actual application callbacks with a synthetic persistence queue,
// without loading account services or touching a user's learning library.
const app=ts.createSourceFile('App.tsx',await readFile('apps/local-ui/src/App.tsx','utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const component=app.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='App');
const handler=name=>component.body.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name).getText(app);
const notebook=ts.createSourceFile('NotebookLesson.tsx',await readFile('apps/local-ui/src/components/NotebookLesson.tsx','utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const notebookComponent=notebook.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='NotebookLesson');
const finishHandler=notebookComponent.body.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='finishLesson');
const interactionLock=notebookComponent.body.statements.find(node=>ts.isVariableStatement(node)&&node.declarationList.declarations.some(declaration=>declaration.name.getText(notebook)==='interactionLocked'));
let layout,toast,finishButton;
function visit(node){
 if(ts.isJsxElement(node)){
  const className=node.openingElement.attributes.properties.find(attribute=>ts.isJsxAttribute(attribute)&&attribute.name.getText(notebook)==='className');
  if(className?.initializer?.text==='notebook-layout')layout=node;
  if(className?.initializer?.text==='notebook-toast')toast=node;
  if(node.openingElement.tagName.getText(notebook)==='GameButton'&&node.openingElement.attributes.properties.some(attribute=>ts.isJsxAttribute(attribute)&&attribute.name.getText(notebook)==='onClick'&&attribute.initializer?.getText(notebook).includes('finishLesson()')))finishButton=node;
 }
 ts.forEachChild(node,visit);
}
visit(notebook);assert.ok(finishHandler&&interactionLock&&finishButton&&layout&&toast,'Exercise the completion handler and its actual interaction/error surfaces');
await mkdir('tmp/checks/lesson-complete-navigation',{recursive:true});
const directory=await mkdtemp(resolve('tmp/checks/lesson-complete-navigation/run-')),outfile=join(directory,'handlers.mjs');
await build({stdin:{loader:'tsx',resolveDir:process.cwd(),contents:`
 import React from 'react';
 import {renderToStaticMarkup} from 'react-dom/server';
 export function createHarness(fixture){
  const {adventure,lessonId,learningProgress,adventureRef,projectRequest}=fixture;
  const changingProgress={current:false};
  const setLearningBusy=value=>{fixture.busy=value};
  const setLearningError=value=>{fixture.error=value};
  const setLearningProgress=value=>{fixture.progress=value;fixture.events.push('progress')};
  const setLearningReadAttempt=change=>{fixture.readAttempt=change(fixture.readAttempt)};
  const setLessonId=value=>{fixture.lessonId=value};
  const planningError=cause=>cause.message;
  const initialPage=()=>fixture.page;
  const navigate=page=>{fixture.events.push('navigate:'+page);fixture.page=page;projectRequest.current++};
  const learningService={complete:(...args)=>{fixture.args=args;fixture.events.push('write');return fixture.operation()}};
  ${handler('updateLearning')}
  ${handler('completeLesson')}
  return {completeLesson};
 }
 export function createNotebookHarness(fixture){
  const {store,alive,onComplete,identity,finishIdentity}=fixture;
  const busy=fixture.busy??false,working=fixture.working??false,current=fixture.current??{},completed=fixture.completed??false;
  const finishingRequest={current:null};
  const setFinishingTarget=value=>{fixture.finishingTarget=value};
  const setNotice=value=>{fixture.notice=value};
  const t=zh=>zh;
  ${finishHandler.getText(notebook)}
  return {finishLesson,renderLayout(){
   const finishingTarget=fixture.finishingTarget,chatWidth=28;
   ${interactionLock.getText(notebook)}
   return renderToStaticMarkup(${layout.openingElement.getText(notebook)}<input aria-label="Note" defaultValue="Retained draft" />${layout.closingElement.getText(notebook)});
  },renderButton(){
   const finishingTarget=fixture.finishingTarget;
   ${interactionLock.getText(notebook)}
   const GameButton=props=><button {...props}/>;
   return renderToStaticMarkup(${finishButton.getText(notebook)});
  }};
 }
 export function renderCompletionMessage(error,notice){
  const t=zh=>zh,setNotice=()=>{},X=()=>null;
  return renderToStaticMarkup((notice||error)&&(${toast.getText(notebook)}));
 }
 `},bundle:true,platform:'node',format:'esm',packages:'external',outfile});
const {createHarness,createNotebookHarness,renderCompletionMessage}=await import(pathToFileURL(outfile).href);
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}};
const fixture=operation=>{
 const adventure={projectId:'synthetic-project',route:{id:'synthetic-route',revision:1}};
 return {adventure,lessonId:'lesson-2',learningProgress:{progressRevision:3},adventureRef:{current:adventure},
  projectRequest:{current:7},page:'lesson',events:[],readAttempt:0,operation};
};
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('finishing persists the selected lesson before returning to its map page',async()=>{
 const write=deferred(),state=fixture(()=>write.promise),app=createHarness(state);
 const pending=app.completeLesson();
 assert.equal(state.page,'lesson');assert.equal(state.busy,true);
 await app.completeLesson();
 assert.deepEqual(state.events,['write']);
 assert.deepEqual(state.args,[state.adventure.projectId,state.adventure.route,'lesson-2',3]);
 const saved={progressRevision:4,completedNodeIds:new Set(['lesson-2'])};
 write.resolve(saved);await pending;
 assert.equal(state.progress,saved);assert.equal(state.page,'map');
 assert.deepEqual(state.events,['write','progress','navigate:map']);
 assert.equal(state.lessonId,'lesson-2','The map should retain the just-completed lesson as its page anchor');
 assert.equal(state.busy,false);assert.equal(state.error,false);
});

test('failed completion retains the lesson and its draft, and can be retried',async()=>{
 for(const message of ['PLANNING_STORAGE_UNAVAILABLE','PLANNING_CONFLICT']){
  const state=fixture(async()=>{throw new Error(message)}),app=createHarness(state);
  await app.completeLesson();
  assert.equal(state.page,'lesson');assert.equal(state.lessonId,'lesson-2');
  assert.equal(state.error,true);assert.equal(state.busy,false);
  assert.ok(!state.events.some(event=>event.startsWith('navigate')));
  if(message==='PLANNING_CONFLICT')assert.equal(state.readAttempt,1);
  state.operation=async()=>({progressRevision:4});
  await app.completeLesson();assert.equal(state.page,'map');assert.equal(state.error,false);
 }
});

test('a late completion cannot pull a different project or navigation flow back to the map',async()=>{
 for(const leave of [
  state=>{state.page='home';state.projectRequest.current++},
  state=>{state.projectRequest.current+=2},
  state=>{state.adventureRef.current={projectId:'another-project',route:{id:'another-route'}}},
 ]){
  const write=deferred(),state=fixture(()=>write.promise),app=createHarness(state);
  const pending=app.completeLesson();leave(state);write.resolve({progressRevision:4});await pending;
  assert.ok(!state.events.some(event=>event.startsWith('navigate')));
 }
 const departed=fixture(async()=>({progressRevision:4}));departed.page='home';
 await createHarness(departed).completeLesson();assert.deepEqual(departed.events,[]);
});

const notebookFixture=(flush,onComplete)=>{
 const identity={projectId:'project',routeId:'route',nodeId:'lesson'};
 return {store:{flush},onComplete,alive:{current:true},identity,finishIdentity:{current:identity},finishingTarget:null};
};

test('notebook blocks editing and duplicate completion throughout both saves',async()=>{
 const flush=deferred(),progress=deferred();let flushed=0,completed=0;
 const state=notebookFixture(()=>{flushed++;return flush.promise},()=>{completed++;return progress.promise}),notebook=createNotebookHarness(state);
 assert.doesNotMatch(notebook.renderLayout(),/\binert=/);
 const pending=notebook.finishLesson();
 assert.equal(state.finishingTarget,state.identity);assert.match(notebook.renderLayout(),/inert=""/);assert.match(notebook.renderButton(),/disabled=""/);
 await notebook.finishLesson();assert.equal(flushed,1);assert.equal(completed,0);
 flush.resolve(true);await tick();
 assert.equal(completed,1);assert.equal(state.finishingTarget,state.identity);
 assert.match(notebook.renderLayout(),/inert=""/,'Editors and all workspace controls stay inert while completion is being persisted');
 assert.match(notebook.renderButton(),/disabled=""/);
 await notebook.finishLesson();assert.equal(completed,1);
 progress.resolve();await pending;
 assert.equal(state.finishingTarget,null);assert.doesNotMatch(notebook.renderLayout(),/\binert=/);assert.doesNotMatch(notebook.renderButton(),/disabled=/);
});

test('notebook re-enables editing after save failures and permits a fresh retry',async()=>{
 let available=false,completed=0;
 const state=notebookFixture(async()=>available,async()=>{completed++;if(completed===1)throw Error('progress unavailable')}),notebook=createNotebookHarness(state);
 await notebook.finishLesson();assert.equal(completed,0);assert.equal(state.finishingTarget,null);
 assert.doesNotMatch(notebook.renderLayout(),/\binert=/);
 available=true;await notebook.finishLesson();
 assert.equal(state.finishingTarget,null);assert.equal(state.notice,'保存失败，请重试。');
 assert.doesNotMatch(notebook.renderLayout(),/\binert=/);
 await notebook.finishLesson();assert.equal(completed,2);assert.equal(state.finishingTarget,null);
});

test('unmounted or reused notebook checkpoints cannot complete a stale lesson',async()=>{
 for(const invalidate of [state=>{state.alive.current=false},state=>{state.finishIdentity.current={...state.identity,nodeId:'another-lesson'}}]){
  const flush=deferred();let completed=0;
  const state=notebookFixture(()=>flush.promise,()=>{completed++}),notebook=createNotebookHarness(state);
  const pending=notebook.finishLesson();invalidate(state);flush.resolve(true);await pending;
  assert.equal(completed,0);
 }
 let completed=0;
 const state=notebookFixture(async()=>true,()=>{completed++});state.completed=true;
 await createNotebookHarness(state).finishLesson();assert.equal(completed,0,'Reopening a completed lesson must remain readable without navigation');
});

test('progress-save failures remain visible even when an older notice exists',()=>{
 const markup=renderCompletionMessage('保存失败，请重试。','已存为资料下方的笔记。');
 assert.match(markup,/role="alert"/);assert.match(markup,/保存失败，请重试。/);
 assert.doesNotMatch(markup,/已存为资料下方的笔记/);
 assert.doesNotMatch(markup,/<button/,'An error must not offer a dismiss action that only clears the unrelated notice');
 assert.match(renderCompletionMessage('','已存为资料下方的笔记。'),/role="status"/);
});
