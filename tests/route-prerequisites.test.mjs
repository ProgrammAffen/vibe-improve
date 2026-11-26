import test from 'node:test';
import assert from 'node:assert/strict';
import {MAX_ROUTE_PREREQUISITES,routePrerequisiteOptions,setRoutePrerequisites} from '../packages/domain/route-prerequisites.mjs';
import {validateRoute} from '../packages/domain/route-validation.mjs';
import {createPlanning,saveEditor,confirmRoute,undoEditor,redoEditor,validatePlanning} from '../packages/domain/planning.mjs';
import {learningPrerequisiteIds} from '../packages/domain/route-learning.mjs';
import {moveRouteItem} from '../packages/domain/route-order.mjs';

const lesson=(id,prerequisites=[])=>({id,title:'Lesson '+id,objectives:[{id:'goal_'+id,description:'Explain '+id}],prerequisites,estimatedMinutes:30});
const route=()=>({format:'vibe-improve.route',schemaVersion:2,id:'synthetic',revision:1,title:'Synthetic plan',locale:'en',sourceLanguage:'en',chapters:[
 {id:'chapterA',title:'First chapter',stageGoal:'Establish the foundations.',nodes:[lesson('a'),lesson('b',['a']),lesson('c',['b'])]},
 {id:'chapterB',title:'Second chapter',stageGoal:'Apply the foundations.',nodes:[lesson('d'),lesson('e')]},
]});
const byId=(value,id)=>value.chapters.flatMap(chapter=>chapter.nodes).find(node=>node.id===id);

test('choices use current outline numbering and allow independent later lessons across chapters',()=>{
 const value=route(),before=structuredClone(value),choices=routePrerequisiteOptions(value,'c');
 assert.deepEqual(choices.map(choice=>[choice.value,choice.number]),[['a','1.1'],['b','1.2'],['d','2.1'],['e','2.2']]);
 assert.equal(choices.find(choice=>choice.value==='b').selected,true);
 assert.equal(choices.find(choice=>choice.value==='d').disabled,false);
 assert.deepEqual(value,before);
 const changed=setRoutePrerequisites(value,'c',['b','d','e','d']);
 assert.deepEqual(byId(changed,'c').prerequisites,['b','d','e']);
 assert.deepEqual(value,before);assert.equal(validateRoute(changed),changed);
 assert.equal(setRoutePrerequisites(changed,'c',['b','d','e']),changed);
});

test('direct and transitive dependents are disabled and cannot introduce cycles',()=>{
 const value=route(),choices=routePrerequisiteOptions(value,'a');
 for(const id of ['b','c']){
  assert.deepEqual(choices.find(choice=>choice.value===id),{value:id,number:id==='b'?'1.2':'1.3',title:'Lesson '+id,selected:false,disabled:true,problem:'cycle'});
  assert.throws(()=>setRoutePrerequisites(value,'a',[id]),/ROUTE_PREREQUISITE_CYCLE/);
 }
 assert.ok(!choices.some(choice=>choice.value==='a'));
 assert.throws(()=>setRoutePrerequisites(value,'a',['a']),/ROUTE_PREREQUISITE_SELF/);
 assert.throws(()=>setRoutePrerequisites(value,'a',['missing']),/ROUTE_PREREQUISITE_UNAVAILABLE/);
 assert.throws(()=>setRoutePrerequisites(value,'missing',[]),/ROUTE_PREREQUISITE_UNAVAILABLE/);
 assert.deepEqual(routePrerequisiteOptions(value,'missing'),[]);
});

test('legacy missing, self, and cyclic selected references stay visible and removable',()=>{
 let value=route();byId(value,'a').prerequisites=['a','missing','c'];
 const choices=routePrerequisiteOptions(value,'a');
 for(const [id,problem] of [['a','self'],['missing','missing'],['c','cycle']]){
  const choice=choices.find(choice=>choice.value===id);
  assert.equal(choice.selected,true);assert.equal(choice.disabled,false);assert.equal(choice.problem,problem);
 }
 value=setRoutePrerequisites(value,'a',['missing','c']);
 value=setRoutePrerequisites(value,'a',['c']);
 value=setRoutePrerequisites(value,'a',[]);
 assert.equal(validateRoute(value),value);
 assert.deepEqual(byId(value,'a').prerequisites,[]);
 // Unrelated unfinished fields must not make this repair impossible.
 byId(value,'d').title='';
 value=setRoutePrerequisites(value,'e',['a']);
 assert.deepEqual(byId(value,'e').prerequisites,['a']);
 assert.equal(byId(value,'d').title,'');
});

test('selection follows the existing contract limit and keeps chosen options removable at capacity',()=>{
 const value=route(),root=byId(value,'a');
 value.chapters[0].nodes=Array.from({length:64},(_,index)=>lesson('n'+index));
 value.chapters[1].nodes=[root,lesson('last'),lesson('extra')];
 const ids=value.chapters[0].nodes.map(node=>node.id);
 assert.equal(MAX_ROUTE_PREREQUISITES,64);
 const full=setRoutePrerequisites(value,'a',[...ids,ids[0]]);
 assert.equal(byId(full,'a').prerequisites.length,64);assert.equal(validateRoute(full),full);
 const choices=routePrerequisiteOptions(full,'a');
 assert.ok(choices.filter(choice=>choice.selected).every(choice=>!choice.disabled));
 assert.equal(choices.find(choice=>choice.value==='last').problem,'limit');
 assert.throws(()=>setRoutePrerequisites(full,'a',[...ids,'last']),/ROUTE_PREREQUISITE_LIMIT/);
 const freed=setRoutePrerequisites(full,'a',ids.slice(1));
 assert.equal(routePrerequisiteOptions(freed,'a').find(choice=>choice.value==='last').disabled,false);
 const legacyOverLimit=structuredClone(full);byId(legacyOverLimit,'a').prerequisites=[...ids,'last','extra'];
 const partlyRepaired=setRoutePrerequisites(legacyOverLimit,'a',[...ids,'last']);
 assert.equal(byId(partlyRepaired,'a').prerequisites.length,65,'An over-limit legacy draft must allow incremental removal');
 assert.equal(validateRoute(setRoutePrerequisites(partlyRepaired,'a',ids)).chapters[1].nodes[0].prerequisites.length,64);
 assert.throws(()=>setRoutePrerequisites(value,'a',null),/ROUTE_PREREQUISITE_INVALID/);
 assert.throws(()=>setRoutePrerequisites(value,'a',[0]),/ROUTE_PREREQUISITE_INVALID/);
});

test('manual multi-selection persists, gates learning, and survives undo redo and reordering by stable id',()=>{
 const project='proj_12345678-1234-4234-8234-123456789abc';
 let state=createPlanning(project,null,'en',route());
 const changed=setRoutePrerequisites(state.routeDraft,'e',['a','d']);
 state=saveEditor(state,changed,state.revision);
 state=confirmRoute(state,state.revision);
 state=validatePlanning(JSON.parse(JSON.stringify(state)));
 assert.deepEqual(learningPrerequisiteIds(state.routeDraft,'e'),['a','d']);
 state=undoEditor(state,state.revision);assert.deepEqual(byId(state.routeDraft,'e').prerequisites,[]);
 state=redoEditor(state,state.revision);assert.deepEqual(byId(state.routeDraft,'e').prerequisites,['a','d']);
 const moved=moveRouteItem(state.routeDraft,{chapterId:'chapterA',nodeId:'a'},{chapterId:'chapterB',nodeId:'d'});
 assert.deepEqual(byId(moved,'e').prerequisites,['a','d']);
 const choice=routePrerequisiteOptions(moved,'e').find(choice=>choice.value==='a');
 assert.equal(choice.number,'2.2');assert.equal(choice.selected,true);
});
