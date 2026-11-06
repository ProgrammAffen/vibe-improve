import test from 'node:test';
import assert from 'node:assert/strict';
import {planningMentionToken,planningMentionTokens,planningMentionDeletion,resolvePlanningMentions,refreshPlanningMentions,validatePlanningMentions} from '../packages/domain/planning-references.mjs';
import {createPlanning,appendUser,cancelPlanningRequest,validatePlanning,saveEditor} from '../packages/domain/planning.mjs';

const route=()=>({format:'vibe-improve.route',schemaVersion:2,id:'sample',revision:1,title:'Synthetic route',locale:'zh-CN',sourceLanguage:'zh-CN',chapters:[{id:'chapterA',title:'A',stageGoal:'Stage A',nodes:Array.from({length:10},(_,i)=>({id:'lesson'+i,title:'Lesson '+i,objectives:[{id:'goal',description:'Specific goal '+i}],prerequisites:[],estimatedMinutes:30,activities:['Study and practice '+i]}))},{id:'chapterB',title:'B',stageGoal:'Stage B',nodes:[{id:'lessonB',title:'B1',objectives:[{id:'goalB',description:'Goal B'}],prerequisites:[],estimatedMinutes:20}]}]});
test('backspace removes a complete bound mention, including its insertion spacer',()=>{
 const r=route();
 for(const token of ['@1.1节','@第1章','@Lesson1.10','@Chapter2'])for(const space of ['',' ']){
  const text='Keep '+token+space,refs=resolvePlanningMentions(r,text),range=planningMentionDeletion(text,text.length,text.length,'backward',refs);
  assert.deepEqual(range,{start:5,end:text.length});assert.equal(text.slice(0,range.start)+text.slice(range.end),'Keep ');
 }
});
test('deletion from inside a mention and partial selections expands to whole references',()=>{
 const text='A @1.1节 B @第2章 C',refs=resolvePlanningMentions(route(),text),a=text.indexOf('@'),b=text.indexOf('@',a+1);
 assert.deepEqual(planningMentionDeletion(text,a+2,a+2,'backward',refs),{start:a,end:a+5});
 assert.deepEqual(planningMentionDeletion(text,a,a,'forward',refs),{start:a,end:a+5});
 assert.deepEqual(planningMentionDeletion(text,a+1,b+2,'backward',refs),{start:a,end:b+4});
});
test('ordinary text, unknown references and unrelated separators retain native deletion',()=>{
 const text='@1.1节 plain  @99.1节',refs=resolvePlanningMentions(route(),'@1.1节');
 for(const caret of [0,8,12,text.length])assert.equal(planningMentionDeletion(text,caret,caret,'backward',refs),null);
 assert.equal(planningMentionDeletion(text,0,0,'backward',refs),null);
 assert.equal(planningMentionDeletion(text,5,5,'forward',refs),null);
 assert.equal(planningMentionDeletion(text,7,9,'backward',refs),null);
});
test('deleting one of several references only removes that reference from the next request',()=>{
 const text='@第1章 @1.1节 ',refs=resolvePlanningMentions(route(),text),range=planningMentionDeletion(text,text.length,text.length,'backward',refs);
 const next=text.slice(0,range.start)+text.slice(range.end);
 assert.equal(next,'@第1章 ');assert.deepEqual(resolvePlanningMentions(route(),next,refs),[refs[0]]);
});
test('inline mentions resolve several chapters and lessons, including overlapping scopes',()=>{
 const r=route(),text='结合 @1.1节、@第1章 和 @第2章 修改目标。';
 const refs=resolvePlanningMentions(r,text);assert.deepEqual(refs,[{token:'@1.1节',target:{chapterId:'chapterA',nodeId:'lesson0'}},{token:'@第1章',target:{chapterId:'chapterA'}},{token:'@第2章',target:{chapterId:'chapterB'}}]);
 assert.equal(planningMentionToken(r,refs[0].target,'zh-CN'),'@1.1节');assert.equal(planningMentionToken(r,refs[1].target,'en'),'@Chapter1');
 assert.equal(resolvePlanningMentions(r,'@1.1节 @1.1节').length,1);
});
test('English ordinals do not confuse 1.1 with 1.10 and direct typing is supported',()=>{
 const r=route(),refs=resolvePlanningMentions(r,'Compare @Lesson1.1 and @Lesson1.10 with @Chapter2.');
 assert.deepEqual(refs.map(m=>m.target.nodeId),['lesson0','lesson9',undefined]);assert.deepEqual(planningMentionTokens('@Lesson1.10 @Chapter12'),['@Lesson1.10','@Chapter12']);
});
test('reordering renumbers bound mentions without changing identity, including swaps',()=>{
 const r=route(),text='@第1章 @第2章 @1.1节',refs=resolvePlanningMentions(r,text);r.chapters.reverse();
 const next=refreshPlanningMentions(r,text,refs,'zh-CN');assert.equal(next.text,'@第2章 @第1章 @2.1节');assert.deepEqual(resolvePlanningMentions(r,next.text,next.mentions).map(m=>m.target),refs.map(m=>m.target));
 const en=refreshPlanningMentions(r,next.text,next.mentions,'en');assert.equal(en.text,'@Chapter2 @Chapter1 @Lesson2.1');
});
test('removing mention text excludes its content and deleted IDs never rebind to the same ordinal',()=>{
 const r=route(),refs=resolvePlanningMentions(r,'@1.1节 @第2章');assert.deepEqual(resolvePlanningMentions(r,'Only @第2章',refs),[refs[1]]);
 r.chapters[0].nodes.shift();assert.throws(()=>resolvePlanningMentions(r,'@1.1节',refs),/PLANNING_TARGET_UNAVAILABLE/);
 assert.deepEqual(resolvePlanningMentions(r,'@1.1节')[0].target,{chapterId:'chapterA',nodeId:'lesson1'});
});
test('invalid, forged, duplicate and oversized references are rejected',()=>{
 const r=route();for(const text of ['@99.1节','@第99章','@Lesson1.99'])assert.throws(()=>resolvePlanningMentions(r,text),/PLANNING_TARGET_UNAVAILABLE/);
 for(const refs of [[{token:'@1.1节',target:{chapterId:'chapterA'},content:'untrusted'}],[{token:'@1.1节',target:{chapterId:'chapterA',path:'/not-allowed'}}],[{token:'@1.1节',target:{chapterId:'chapterA'}},{token:'@1.1节',target:{chapterId:'chapterA'}}],Array(33).fill({token:'@1.1节',target:{chapterId:'chapterA'}})])assert.throws(()=>validatePlanningMentions(r,'@1.1节',refs),/PLANNING_TARGET_UNAVAILABLE/);
 assert.throws(()=>validatePlanningMentions(r,'No mention',[{token:'@1.1节',target:{chapterId:'chapterA'}}]),/PLANNING_TARGET_UNAVAILABLE/);
});
test('multi-mentions persist and retry with the same content once, while old single targets still work',()=>{
 const r=route();let state=createPlanning('proj_12345678-1234-4234-8234-123456789abc','codex','zh-CN',r);const text='Compare @第1章 and @2.1节',mentions=resolvePlanningMentions(r,text);
 state=appendUser(state,text,'user1','req1',state.revision,undefined,undefined,mentions);assert.deepEqual(validatePlanning(JSON.parse(JSON.stringify(state))).messages[0].mentions,mentions);
 state=cancelPlanningRequest(state,'req1',state.revision);state=appendUser(state,text,'user2','req2',state.revision,undefined,undefined,mentions);assert.equal(state.messages.length,1);
 state=cancelPlanningRequest(state,'req2',state.revision);state=saveEditor(state,{...state.routeDraft,chapters:[]},state.revision);assert.equal(validatePlanning(state).messages.length,1);
 assert.throws(()=>appendUser(state,text,'user3','req3',state.revision,undefined,undefined,mentions),/PLANNING_TARGET_UNAVAILABLE/);
});
