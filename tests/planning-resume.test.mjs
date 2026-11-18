import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import * as p from '../packages/domain/planning.mjs';
const project='proj_12345678-1234-4234-8234-123456789abc';
function collected(){let state=p.createPlanning(project,'codebuddy','en');for(const question of state.questions){const id=question.id,request='request_'+id,message='message_'+id,fields={goal:{topic:'CSV processing',outcome:'Create a CSV report'},purpose:{context:'Personal practice',criteria:'Verify totals'},baseline:{experience:'Know Python basics'},time:{weekly:'Four hours',session:'One hour'}}[id];state=p.appendUser(state,JSON.stringify(fields),message,request,state.revision);state=p.applyInterview(state,{reply:'Confirm.',summary:Object.values(fields).join(' / '),updates:[{id,fields,evidence:Object.keys(fields).map(field=>({field,messageId:message,quote:'Synthetic answer'})),missing:[],complete:true}],consistency:{status:'consistent',issues:[]}},request,state.revision);state=p.acceptAnswer(state,id,state.questions.find(q=>q.id===id).answerProposal.messageId,state.revision)}return state}
const routeID='route_12345678-1234-4234-8234-123456789abc';
const outline={status:'ok',reply:'Outline ready.',result:{title:'CSV practice',chapters:[{title:'Foundations',stageGoal:'Apply five named concepts.',lessons:Array.from({length:5},(_,i)=>({title:'Concept '+(i+1),focus:'Study, practice and explain.'}))},{title:'Application',stageGoal:'Create a report.',lessons:[{title:'Report',focus:'Complete a report independently.'}]}]},missing:[]};
function chapter(index,count){const c=outline.result.chapters[index];return{id:`ch_${index+1}`,title:c.title,stageGoal:c.stageGoal,nodes:c.lessons.slice(0,count).map((n,j)=>{const id=`node_${index+1}_${j+1}`;return{id,title:n.title,objectives:[{id:id+'_o1',description:'Apply the named concept in a practice case.'}],prerequisites:index?['node_1_5']:[],estimatedMinutes:30,activities:['Study a worked example.','Solve a new case and compare.']}})}}
function checkpoint(state,parts=[chapter(0,3),null],request='gen'){return p.saveGenerationProgress(state,{routeId:routeID,outline,chapters:parts},request,state.revision)}
const oldRoute=JSON.parse(await readFile('contracts/examples/route.valid.json','utf8'));
// Do not couple fixtures to the revision count of the interview implementation.
function withOld(){let state=collected();state=p.importRoute(state,oldRoute,state.revision);return p.reopenIntake(state,state.revision)}

test('validated generation progress is separate, monotonic and survives cancellation and process recovery',()=>{
 let state=withOld(),old=structuredClone(state.routeDraft);state=p.startGeneration(state,'gen',state.revision,true);const base=state.revision;
 let saved=checkpoint(state);assert.equal(saved.revision,base);assert.deepEqual(saved.routeDraft,old);assert.deepEqual(p.generationProgress(saved),{completed:3,total:6,resumable:true});assert.equal(saved.generationDraft.revision,1);
 saved=checkpoint(saved,[chapter(0,3),chapter(1,1)]);assert.equal(saved.generationDraft.revision,2);assert.throws(()=>checkpoint(saved,[null,chapter(1,1)]),/PLANNING_CONFLICT/);
 const recovered=p.recoverPlanning(saved);assert.equal(recovered.pending,undefined);assert.deepEqual(recovered.generationDraft,saved.generationDraft);assert.deepEqual(recovered.routeDraft,old);
 assert.throws(()=>checkpoint(recovered),/PLANNING_CONFLICT/);assert.throws(()=>p.startGeneration(recovered,'new',recovered.revision,true),/PLANNING_GENERATION_EXISTS/);
 const resumed=p.startGeneration(recovered,'next',recovered.revision,true,'resume');assert.equal(resumed.generationDraft.routeId,routeID);assert.throws(()=>p.saveGenerationProgress(resumed,{routeId:routeID,outline,chapters:[chapter(0,5),chapter(1,1)]},'gen',base),/PLANNING_CONFLICT/);
 const full=checkpoint(resumed,[chapter(0,5),chapter(1,1)],'next'),draft=full.generationDraft;
 const route={format:'vibe-improve.route',schemaVersion:2,id:routeID,revision:1,title:outline.result.title,locale:'en',sourceLanguage:'en',chapters:draft.chapters};
 assert.throws(()=>p.applyGenerated(full,{...route,title:'Unexpected'},'next',full.revision),/PLANNING_GENERATION_INVALID/);
 const revised=structuredClone(route);revised.chapters[0].nodes[3].activities=['Use a supplied practice input and verify the result.'];
 assert.throws(()=>p.applyGenerated(full,revised,'next',full.revision),/PLANNING_GENERATION_INVALID/);
 for(const revisedLessons of [['node_1_3'],['node_1_4','node_1_5'],['node_1_4','node_1_4'],['node_missing']]){
  assert.throws(()=>p.applyGenerated(full,revised,'next',full.revision,revisedLessons),/PLANNING_GENERATION_INVALID/);
 }
 assert.throws(()=>p.applyGenerated(full,{...revised,title:'Changed title'},'next',full.revision,['node_1_4']),/PLANNING_GENERATION_INVALID/);
 const renamed=structuredClone(revised);renamed.chapters[0].nodes[3].title='Verify the result of an analysis';
 assert.throws(()=>p.applyGenerated(full,renamed,'next',full.revision,['node_1_4']),/PLANNING_GENERATION_INVALID/);
 for(const names of [['node_1_3'],['node_1_4','node_1_4']])assert.throws(()=>p.applyGenerated(full,renamed,'next',full.revision,['node_1_4'],names),/PLANNING_GENERATION_INVALID/);
 assert.throws(()=>p.applyGenerated(full,revised,'next',full.revision,['node_1_4'],['node_1_4']),/PLANNING_GENERATION_INVALID/);
 assert.deepEqual(p.applyGenerated(full,renamed,'next',full.revision,['node_1_4'],['node_1_4']).routeDraft,renamed);
 const approved=p.applyGenerated(full,revised,'next',full.revision,['node_1_4']);assert.deepEqual(approved.routeDraft,revised);
 const applied=p.applyGenerated(full,route,'next',full.revision);assert.deepEqual(applied.routeDraft,route);assert.equal(applied.generationDraft,undefined);assert.equal(applied.pending,undefined);assert.equal(applied.step,'editor');assert.deepEqual(applied.history.past.at(-1),old);
});

test('resume binds semantic context and original route, permits model switching, and restart is explicit',()=>{
 let state=withOld();state=p.startGeneration(state,'gen',state.revision,true);state=checkpoint(state);state=p.cancelPlanningRequest(state,'gen',state.revision);
 state=p.setAgentOptions(state,{model:'another-model',effort:'low'},state.revision);state=p.focusQuestion(state,'purpose',state.revision);state=p.setProvider(state,'codex',state.revision);assert.equal(p.generationProgress(state).resumable,true);
 const previousPrompt=structuredClone(state);previousPrompt.generationDraft.policyVersion='planning.12';
 assert.equal(p.generationProgress(previousPrompt).resumable,true);
 const olderPolicy=structuredClone(state);olderPolicy.generationDraft.policyVersion='planning.10';
 assert.equal(p.generationProgress(olderPolicy).resumable,false);
 assert.throws(()=>p.startGeneration(olderPolicy,'upgrade',olderPolicy.revision,true,'resume'),/PLANNING_GENERATION_STALE/);
 const upgraded=p.startGeneration(olderPolicy,'upgrade',olderPolicy.revision,true,'restart');
 assert.deepEqual(upgraded.routeDraft,state.routeDraft);assert.equal(upgraded.generationDraft,undefined);
 const changed=p.setResources(state,'New resource constraints',state.revision);assert.equal(p.generationProgress(changed).resumable,false);
 let ready=p.beginConsistencyCheck(changed,'check',changed.revision);ready=p.applyConsistencyCheck(ready,{reply:'Compatible.',consistency:{status:'consistent',issues:[]}},'check',ready.revision);
 assert.throws(()=>p.startGeneration(ready,'again',ready.revision,true,'resume'),/PLANNING_GENERATION_STALE/);
 const restarted=p.startGeneration(ready,'again',ready.revision,true,'restart');assert.equal(restarted.generationDraft,undefined);assert.deepEqual(restarted.routeDraft,state.routeDraft);
 let editor=p.openEditor(state,state.revision);editor=p.saveEditor(editor,{...editor.routeDraft,title:'Changed original'},editor.revision);editor=p.reopenIntake(editor,editor.revision);assert.equal(p.generationProgress(editor).resumable,false);
 const legacy=collected();assert.equal(p.validatePlanning(legacy),legacy);assert.equal(p.generationProgress(legacy),null);
});

test('scoped revisions survive reopening without changing the live route',()=>{
 let state=withOld(),old=state.routeDraft;
 state=p.startGeneration(state,'gen',state.revision,true);
 assert.throws(()=>p.saveGenerationRevision(checkpoint(state),null,'gen',state.revision),/PLANNING_GENERATION_INVALID/);
 state=checkpoint(state,[chapter(0,5),chapter(1,1)]);
 state=p.saveGenerationRevision(state,null,'gen',state.revision);
 assert.equal(p.generationProgress(state).revised,0);
 assert.equal(p.saveGenerationRevision(state,null,'gen',state.revision),state);
 const lesson={...state.generationDraft.chapters[0].nodes[3],title:'Verify the median',activities:['Measure the midpoint using fresh input.']};
 const patch={nodes:[lesson],renamedLessons:[lesson.id]};
 assert.throws(()=>p.saveGenerationRevision(state,{...patch,renamedLessons:[]},'gen',state.revision),/PLANNING_GENERATION_INVALID/);
 assert.throws(()=>p.saveGenerationRevision(state,{...patch,nodes:[lesson,chapter(1,1).nodes[0]]},'gen',state.revision),/PLANNING_GENERATION_INVALID/);
 assert.throws(()=>p.saveGenerationRevision(state,{...patch,nodes:[{...lesson,prerequisites:['node_2_1']}]},'gen',state.revision),/PLANNING_GENERATION_INVALID/);
 const revised=p.saveGenerationRevision(state,patch,'gen',state.revision);
 assert.deepEqual(revised.routeDraft,old);
 assert.equal(revised.revision,state.revision);
 assert.equal(revised.generationDraft.outline.result.chapters[0].lessons[3].title,lesson.title);
 assert.deepEqual(revised.generationDraft.chapters[1],state.generationDraft.chapters[1]);
 const reopened=p.recoverPlanning(JSON.parse(JSON.stringify(revised)));
 assert.deepEqual(p.generationProgress(reopened),{completed:6,total:6,resumable:true,revised:1});
 assert.throws(()=>p.saveGenerationRevision(reopened,patch,'gen',revised.revision),/PLANNING_CONFLICT/);
 const active=p.startGeneration(reopened,'resume',reopened.revision,true,'resume');
 const draft=active.generationDraft;
 const route={format:'vibe-improve.route',schemaVersion:2,id:draft.routeId,revision:1,title:draft.outline.result.title,locale:'en',sourceLanguage:'en',chapters:draft.chapters};
 assert.throws(()=>p.applyGenerated(active,{...route,chapters:state.generationDraft.chapters},'resume',active.revision),/PLANNING_GENERATION_INVALID/);
 const applied=p.applyGenerated(active,route,'resume',active.revision);
 assert.deepEqual(applied.routeDraft,route);
 assert.deepEqual(applied.history.past.at(-1),old);
 assert.equal(applied.generationDraft,undefined);
});

test('a resumed checkpoint preserves the shared practice rules without changing the route contract',()=>{
 let state=collected();state=p.startGeneration(state,'gen',state.revision);
 const outlineWithRules=structuredClone(outline);
 const rules=['Compare each reading with the time point named by the question.'];
 outlineWithRules.result.practiceRules=rules;
 const saved=p.saveGenerationProgress(state,{routeId:routeID,outline:outlineWithRules,chapters:[chapter(0,3),null]},'gen',state.revision);
 const recovered=p.recoverPlanning(saved);
 assert.equal(p.generationProgress(recovered).resumable,true);
 assert.deepEqual(recovered.generationDraft.outline.result.practiceRules,rules);
 for(const invalid of [[],[' '],[rules[0],rules[0]],['x'.repeat(401)]]){
  const tampered=structuredClone(saved);tampered.generationDraft.outline.result.practiceRules=invalid;
  assert.throws(()=>p.validatePlanning(tampered),/PLANNING_GENERATION_INVALID/);
 }
});

test('corrupt caches, incomplete batches, future dependencies and rewritten prefixes are rejected',()=>{
 let state=collected();state=p.startGeneration(state,'gen',state.revision);
 for(const parts of [[chapter(0,1),null],[{...chapter(0,3),id:'other'},null]])assert.throws(()=>checkpoint(state,parts),/PLANNING_GENERATION_INVALID/);
 const future=chapter(0,3);future.nodes[0].prerequisites=['node_1_4'];assert.throws(()=>checkpoint(state,[future,null]),/PLANNING_GENERATION_INVALID/);
 const saved=checkpoint(state),tampered=structuredClone(saved);tampered.generationDraft.extra='unknown';assert.throws(()=>p.validatePlanning(tampered),/PLANNING_GENERATION_INVALID/);
 const changed=chapter(0,5);changed.nodes[0].objectives[0].description='Replaced saved content';assert.throws(()=>checkpoint(saved,[changed,null]),/PLANNING_CONFLICT/);
 const half=structuredClone(saved);half.generationDraft.chapters[0].nodes[0].activities=[];assert.throws(()=>p.validatePlanning(half),/PLANNING_GENERATION_INVALID/);
});

test('UI makes the next generation action primary and retains resume and restart commands',async()=>{
 const parent=resolve('tmp/checks/generation-resume-2026-11-04');await mkdir(parent,{recursive:true});const dir=await mkdtemp(join(parent,'ui-')),bundle=join(dir,'ui.mjs');
 await build({stdin:{contents:`export {PlanningIntakeSurface} from './apps/local-ui/src/components/PlanningPage';export {default as Dialog} from './apps/local-ui/src/components/PlanningGenerationDialog';export {planningService} from './apps/local-ui/src/planning/service';export {generateWithConsistency} from './apps/local-ui/src/planning/generation';export {renderToStaticMarkup} from 'react-dom/server';export {createElement} from 'react';`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'node',format:'esm',packages:'external',loader:{'.css':'empty'},define:{'import.meta.env.BASE_URL':'"/vibe-improve/"'},outfile:bundle,logLevel:'silent'});
 const ui=await import(pathToFileURL(bundle).href),render=(component,props)=>ui.renderToStaticMarkup(ui.createElement(component,props));
 let state=collected();state=p.startGeneration(state,'gen',state.revision);state=checkpoint(state);state=p.cancelPlanningRequest(state,'gen',state.revision);
 for(const language of ['zh-CN','en']){
  const html=render(ui.PlanningIntakeSurface,{state,language});
  assert.match(html,language==='en'?/3 \/ 6 lesson drafts saved/:/已保存 3 \/ 6 节草稿/);
  assert.match(html,language==='en'?/>Resume generation</:/>继续生成路线</);
  assert.match(html,/<details class="planning-intake-more"[^>]*>.*?(Regenerate route|重新生成).*?<\/details>/);
  assert.match(html,/<textarea[^>]*disabled=""/);
  assert.match(html,/<ol\b[^>]*class="planning-question-list"[^>]*>.*?data-optional-resource.*?<\/ol>/);
  const modal=render(ui.Dialog,{language,entries:[],running:false,error:'Synthetic timeout',reviewNeeded:false,savedProgress:p.generationProgress(state),onResume:()=>{}});assert.match(modal,language==='en'?/>Resume generation</:/>继续生成路线</);
 }
 const stale=p.setResources(state,'New context',state.revision);
 const staleHTML=render(ui.PlanningIntakeSurface,{state:stale,language:'en'});
 assert.match(staleHTML,/Generation conditions have changed/);
 assert.match(staleHTML,/<button type="button" class="game-button game-button--primary[^>]*>[\s\S]+?>Generate route<\/span><\/button>/);
 assert.doesNotMatch(staleHTML,/>Resume generation</);
 let pendingReview=collected();
 pendingReview=p.startGeneration(pendingReview,'review_gen',pendingReview.revision);
 pendingReview=checkpoint(pendingReview,[chapter(0,5),chapter(1,1)],'review_gen');
 pendingReview=p.cancelPlanningRequest(pendingReview,'review_gen',pendingReview.revision);
 for(const language of ['zh-CN','en']){
  const resumeLabel=language==='en'?/>Resume generation</:/>继续生成路线</;
  const reviewHTML=render(ui.PlanningIntakeSurface,{state:pendingReview,language});
  assert.match(reviewHTML,resumeLabel);
  assert.match(reviewHTML,language==='en'?/6 \/ 6 lesson drafts saved · Review pending/:/已保存 6 \/ 6 节草稿 · 待审核/);
  assert.match(reviewHTML,/<button disabled=""[^>]*game-button--secondary/);
  const modal=render(ui.Dialog,{language,entries:[],running:false,error:'Synthetic timeout',reviewNeeded:false,
    savedProgress:p.generationProgress(pendingReview),onResume:()=>{}});
  assert.match(modal,resumeLabel);
 }
 let revision=p.startGeneration(pendingReview,'continue_repair',pendingReview.revision,true,'resume');
 const revisedLesson={...revision.generationDraft.chapters[0].nodes[3],activities:['Verify the practice result.']};
 revision=p.saveGenerationRevision(revision,{nodes:[revisedLesson],renamedLessons:[]},'continue_repair',revision.revision);
 revision=p.cancelPlanningRequest(revision,'continue_repair',revision.revision);
 const paused=render(ui.PlanningIntakeSurface,{state:revision,language:'zh-CN'});
 assert.match(paused,/已保存 1 节修订 · 待复审/);
 assert.match(paused,/>继续生成路线</);
 assert.doesNotMatch(paused,/>生成路线</);
 const editing=render(ui.PlanningIntakeSurface,{state:withOld(),language:'en',generationFailed:true});
 const actions=editing.match(/<div class="planning-intake-actions">.*?<\/footer>/)?.[0]??'';
 const [menu,main]=actions.split('</details>');
 assert.doesNotMatch(menu,/Edit existing route|Edit route manually/);
 assert.match(main,/<button type="button" class="game-button game-button--secondary[^>]*>.*?>Edit existing route<\/span>/);
 assert.match(editing,/Generation incomplete · Existing route kept/);
 const empty=render(ui.PlanningIntakeSurface,{state:collected(),language:'en'});
 assert.match(empty,/<details class="planning-intake-more"[^>]*>.*?>Edit route manually<.*?<\/details>/);
 assert.match(empty,/<button disabled=""[^>]*game-button--secondary[^>]*>.*?>Edit existing route<\/span>/);
 assert.match(empty,/No route generated yet<\/p><div class="planning-intake-actions">/);
 const activeState=p.startGeneration(pendingReview,'continue_gen',pendingReview.revision,true,'resume');
 const live='已保存 6 / 6 节草稿 · 正在复核路线内容…';
 const active=render(ui.PlanningIntakeSurface,{state:activeState,language:'zh-CN',busy:true,generationStatus:live});
 assert.ok(active.includes(`role="status">${live}</p><div class="planning-intake-actions">`));
 assert.doesNotMatch(active,/请完成必答项|待审核/);
 assert.match(active,/<button disabled=""[^>]*game-button--primary[^>]*>.*?>继续生成路线<\/span>/);
 const calls=[];globalThis.window={vibeNative:{projects:{request:async(action,value)=>{calls.push({action,value});return {id:'job-'+calls.length,projectId:project,intent:'generate',state:'pending'}}}}};
 try{for(const mode of ['resume','restart'])await ui.planningService.begin(state,'generate',undefined,undefined,undefined,true,mode)}finally{delete globalThis.window}
 assert.deepEqual(calls.map(c=>c.value.generationMode),['resume','restart']);assert.ok(calls.every(c=>c.value.replaceExisting===true));
 const requested=[];assert.equal(await ui.generateWithConsistency(()=>state,async(...args)=>{requested.push(args);return true},true,'resume'),true);assert.deepEqual(requested,[['generate',true,'resume']]);
});

test('native recovery retains original route until a complete candidate passes review',{skip:process.platform!=='darwin',timeout:240000},async()=>{
 const parent=resolve('tmp/checks/generation-resume-2026-11-04');await mkdir(parent,{recursive:true});const dir=await mkdtemp(join(parent,'native-'));
 const source=join(dir,'main.swift'),fixture=join(dir,'fixture.py'),initial=join(dir,'initial.json'),validator=join(dir,'planning.js'),binary=join(dir,'verify');
 await writeFile(initial,JSON.stringify(withOld()));await build({entryPoints:['packages/domain/planning.mjs'],bundle:true,format:'iife',globalName:'VibePlanning',outfile:validator,target:'safari15',logLevel:'silent'});
 await writeFile(fixture,String.raw`import json,os,sys,time
phase=sys.argv[1]
system=sys.argv[sys.argv.index('--system-prompt')+1]
def emit(v):print(json.dumps(v),flush=True)
def issue(refs):return {'code':'alignment','targetRefs':refs,'message':'The fourth concept needs an executable practice input.','fixHint':'Give the learner a concrete practice input.','blocking':True}
def sequence_issue():return {**issue([]),'code':'practice_sequence','message':'The account changes before position_before is recorded. ' * 7 + 'Record the starting balance first.','fixHint':'Prepare the account, record its cash and holdings, then place the practice order.'}
def rename_issue():return {**issue(['L4']),'code':'learning_language','message':'The lesson title does not communicate which data analysis skill is practiced.','fixHint':'Name the independent skill of verifying a median.'}
def second_issue():return {**issue(['L6']),'code':'practice_sequence','message':'The final activity uses an inconsistent baseline.','fixHint':'Use the baseline stated in the practice input.'}
def remaining_issue(remaining):
 return {**issue(['L4']),'code':'practice_sequence' if remaining else 'specificity',
  'message':'The activity reads a hardcoded result instead of the actual input.' if remaining else 'The activity does not explain how to obtain the median.',
  'fixHint':'Derive the middle value from the actual input.' if remaining else 'Explain how to sort and select the middle value.'}
practice=['Calculate the median of the supplied CSV values 3, 5 and 7.']
incomplete_activity='Read the median from a hardcoded value of 5.'
corrected_activity='Sort the actual input, then select the middle value.'
new_title='Verify the median independently'
for line in sys.stdin:
 m=json.loads(line)
 if m.get('type')=='control_request':emit({'type':'control_response','response':{'request_id':m['request_id'],'subtype':'success','response':{}}})
 elif m.get('type')=='user':
  text=m['message']['content'][0]['text'];c=json.loads(text.split('CONTEXT_JSON_DATA:',1)[1]);lessons=c.get('requestedLessons')
  stage='review' if 'TASK: review' in system else 'revision' if 'qualityRevision' in c else 'lessons' if lessons else 'outline'
  record={'phase':phase,'stage':stage,'repair':'repair' in c,'refs':[n['ref'] for n in lessons] if lessons else []}
  earlier=[json.loads(row) for row in open('requests.ndjson')] if os.path.exists('requests.ndjson') else []
  review_count=sum(row['phase']==phase and row['stage']=='review' for row in earlier)
  reviewed=review_count>0
  with open('requests.ndjson','a') as f:f.write(json.dumps(record)+'\n')
  if phase=='wide-repair' and stage=='review':
   nodes=c['candidate']['chapters'][0]['lessons']
   assert len(nodes)==13
   assert all(n['activities']==['Verify the concept against the supplied input.'] for n in nodes) == reviewed
   value={'ready':reviewed,'issues':[] if reviewed else [issue(['C1'])]}
  elif phase=='wide-repair' and stage=='revision':
   fields=['ref','objectives','prerequisites','estimatedMinutes']
   value={'nodes':[{**{key:n[key] for key in fields},'activities':['Verify the concept against the supplied input.']} for n in c['qualityRevision']['requestedCandidate']]}
  elif phase in ['pause-repair','resume-repair'] and stage=='review':
   nodes=[n for chapter in c['candidate']['chapters'] for n in chapter['lessons']]
   expected_last=['Calculate the result using the stated baseline.'] if reviewed or phase=='resume-repair' else ['Study a worked example.','Solve a new case and compare.']
   assert nodes[5]['activities']==expected_last
   if phase=='resume-repair' and reviewed:
    assert nodes[3]['activities']==practice
    value={'ready':True,'issues':[]}
   else:
    blockers=[issue(['L4'])]
    if phase=='pause-repair' and not reviewed:blockers.append(second_issue())
    value={'ready':False,'issues':blockers}
  elif phase in ['pause-repair','resume-repair'] and stage=='revision':
   [target]=record['refs']
   assert target in ['L4','L6']
   activities=practice if target=='L4' else ['Calculate the result using the stated baseline.']
   ref='L5' if phase=='pause-repair' and target=='L4' else target
   value={'nodes':[{'ref':ref,'objectives':['Apply the named concept in a practice case.'],'prerequisites':['L3' if target=='L4' else 'L5'],'estimatedMinutes':30,'activities':activities,'assessment':None}]}
  elif stage=='review':
   assert 'node_' not in json.dumps(c) and 'route_' not in json.dumps(c) and 'proj_' not in json.dumps(c)
   nodes=[n for chapter in c['candidate']['chapters'] for n in chapter['lessons']]
   assert [n['ref'] for n in nodes]==['L1','L2','L3','L4','L5','L6']
   assert set(c['knownRefs'])=={'C1','C2','L1','L2','L3','L4','L5','L6'}
   assert all(n['activities']==['Study a worked example.','Solve a new case and compare.'] for n in nodes if n['ref']!='L4' and not (phase=='second-blocker' and review_count==2 and n['ref']=='L6'))
   if phase=='remaining-blocker' and reviewed:
    assert nodes[3]['activities']==practice+[corrected_activity if review_count==2 else incomplete_activity]
    assert c['previousBlockingIssues']==[remaining_issue(review_count==2)]
    assert all('assessment' not in node and 'review' not in node for node in nodes)
   elif phase in ['repeat','summary','unsafe-summary','long-summary','rename','second-blocker'] and reviewed:
    assert nodes[3]['activities']==practice
    if c.get('localizeBlockingIssues'):assert c['previousBlockingIssues']==[sequence_issue(),issue([])]
    else:assert c.get('previousBlockingIssues')==[rename_issue() if phase=='rename' else second_issue() if phase=='second-blocker' and review_count==2 else issue(['L4'])]
    if phase=='rename':assert nodes[3]['title']==new_title and c['outline']['chapters'][0]['lessons'][3]['title']==new_title
    if phase=='second-blocker' and review_count==2:assert nodes[5]['activities']==['Calculate the result using the stated baseline.']
   else:
    assert nodes[3]['activities']==['Study a worked example.','Solve a new case and compare.']
   if phase=='cancel-review':time.sleep(8)
   if phase=='global':
    assert bool(c.get('localizeBlockingIssues'))==reviewed
    value={'ready':False,'issues':[issue([])]}
   elif phase=='unknown':value={'ready':False,'issues':[issue(['L99'])]}
   elif phase=='duplicate':value={'ready':False,'issues':[issue(['L4','L4'])]}
   elif phase=='mismatch':value={'ready':True,'issues':[issue(['L4'])]}
   elif phase=='malformed':value={'ready':False,'issues':[]}
   elif phase in ['summary','unsafe-summary','long-summary'] and reviewed:
    summary={'summary':'The practice asks learners to record the starting balance after placing an order.','unsafe-summary':'L6 uses position_before after SIM-01.','long-summary':'A long implementation detail. '*20}[phase]
    value={'ready':False,'summary':summary,'issues':[sequence_issue(),issue([]),{**issue(['L2']),'blocking':False}]}
   elif phase=='rename' and not reviewed:value={'ready':False,'issues':[rename_issue()]}
   elif phase=='second-blocker' and review_count<2:value={'ready':False,'issues':[issue(['L4']) if not reviewed else second_issue()]}
   elif phase=='remaining-blocker' and review_count<2:value={'ready':False,'issues':[remaining_issue(reviewed)]}
   elif phase in ['repeat','invalid-revision','invalid-rename','no-op'] or phase in ['summary','unsafe-summary','long-summary'] and not reviewed:value={'ready':False,'issues':[issue(['L4'])]}
   else:value={'ready':True,'issues':[]}
  elif stage=='revision':
   target='L6' if phase=='second-blocker' and review_count==2 else 'L4'
   assert 'TASK: lessons' in system and record['refs']==[target]
   assert 'node_' not in json.dumps(c) and 'route_' not in json.dumps(c) and 'proj_' not in json.dumps(c)
   revision=c['qualityRevision']
   assert revision['blockingIssues']==[rename_issue() if phase=='rename' else second_issue() if target=='L6' else remaining_issue(review_count==2) if phase=='remaining-blocker' else issue(['L4'])]
   assert revision.get('renameableLessonRefs')==(['L4'] if phase=='rename' else None)
   assert [n['ref'] for n in revision['requestedCandidate']]==[target]
   repeated=phase in ['repeat','remaining-blocker'] and review_count==2
   expected_practice=practice+[incomplete_activity] if phase=='remaining-blocker' and repeated else practice
   assert revision['requestedCandidate'][0]['activities']==(expected_practice if repeated else ['Study a worked example.','Solve a new case and compare.'])
   previous_issue=remaining_issue(False) if phase=='remaining-blocker' else issue(['L4'])
   starts=sum(row['phase']==phase and row['stage']=='revision' and not row['repair'] for row in earlier)
   retry=phase in ['no-op','invalid-revision','invalid-rename'] and starts >= (2 if 'repair' in c else 1)
   assert revision.get('previousBlockingIssues')==([previous_issue] if repeated or retry else None)
   value={'nodes':[{'ref':'L4','objectives':['Apply the named concept in a practice case.'],'prerequisites':['L3'],'estimatedMinutes':30,'activities':practice,'assessment':None}]}
   if phase=='remaining-blocker':value['nodes'][0]['activities']=practice+[corrected_activity if repeated else incomplete_activity]
   if target=='L6':value['nodes'][0].update(ref='L6',prerequisites=['L5'],activities=['Calculate the result using the stated baseline.'])
   if phase=='invalid-revision':value['nodes'][0]['ref']='L5'
   if phase in ['rename','invalid-rename']:value['nodes'][0]['title']=new_title
   if phase=='no-op':
    value['nodes'][0]['activities']=['Study a worked example.','Solve a new case and compare.']
  elif not lessons:
   value={'title':'CSV practice','chapters':[{'title':'Foundations','stageGoal':'Apply five named concepts.','lessons':[{'title':'Concept '+str(i),'focus':'Study, practice and explain.'} for i in range(1,6)]},{'title':'Application','stageGoal':'Create a report.','lessons':[{'title':'Report','focus':'Complete a report independently.'}]}]}
  else:
   if phase=='first' and lessons[0]['ref']=='L4':time.sleep(8)
   else:time.sleep(.08)
   available=[n['ref'] for n in c['availablePrerequisites']];nodes=[]
   for n in lessons:
    nodes.append({'ref':n['ref'],'objectives':['Apply the named concept in a practice case.'],'prerequisites':available[-1:],'estimatedMinutes':30,'activities':['Study a worked example.','Solve a new case and compare.'],'assessment':None});available.append(n['ref'])
   value={'nodes':nodes}
   if nodes[0]['ref']=='L1':
    assert any(part['ref']=='R1_s1' for part in c['materialExcerpts'])
    value['materials']=[{'lessonRef':'L1','excerptRef':'R1_s1'}]
  if stage=='review' and value['ready']:
   assert any(part['ref']=='R2_s1' for part in c['materialExcerpts'])
   value['materials']=[{'targetRef':'C1','excerptRef':'R2_s1'}]
  value={'status':'ok','reply':'Saved stage ready.','result':value,'missing':[]}
  if phase=='rename' and stage=='revision':del value['missing']
  payload=json.dumps(value)
  emit({'type':'assistant','message':{'content':[{'type':'text','text':payload}]}});emit({'type':'result','subtype':'success','is_error':False,'result':payload})
  for line in sys.stdin:pass
  sys.exit(0)
`);
 await writeFile(source,`import Foundation
import Darwin
func check(_ condition:Bool,_ message:String){if !condition{fputs(message+"\\n",stderr);exit(1)}}
let root=URL(fileURLWithPath:CommandLine.arguments[1]),fixture=CommandLine.arguments[2],validator=URL(fileURLWithPath:CommandLine.arguments[3]),initial=try Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[4]))
try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
let id="${project}",runtime=try RuntimeDirectory(url:root.appendingPathComponent("runtime")),files=try runtime.child("projects").child("planning")
try files.write(id+".json",data:initial)
let agents=try AgentManager(runtime:runtime,projectWorkspace:{_ in root})
let resource=["id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","version":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"]
let reviewResource=["id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","version":"dddddddd-dddd-4ddd-8ddd-dddddddddddd"]
let expectedLink=resource.merging(["kind":"lesson","targetId":"node_1_1","segmentId":"s1","origin":"ai"]){_,new in new}
let expectedReviewLink=reviewResource.merging(["kind":"chapter","targetId":"ch_1","segmentId":"s1","origin":"ai"]){_,new in new}
func requestRecords()throws->[[String:Any]]{
 guard let text=try? String(contentsOf:root.appendingPathComponent("requests.ndjson"),encoding:.utf8) else{return []}
 return try text.split(separator:"\\n").map{try JSONSerialization.jsonObject(with:Data($0.utf8)) as! [String:Any]}
}
func store()throws->PlanningStore{try PlanningStore(runtime:runtime,validatorURL:validator,workspace:{_ in root})}
func run(_ phase:String,_ store:PlanningStore,_ before:[String:Any],_ failCommit:Bool=false)throws->[String:Any]{
 var prepares=0,applications=0
 let launch=try AgentSessionLaunch(provider:"codebuddy",projectID:id,executable:URL(fileURLWithPath:"/usr/bin/python3"),arguments:[fixture,phase,"--tools",""],workspace:root,environment:ProcessInfo.processInfo.environment)
 let manager=PlanningAgentManager(agents:agents,idleTimeout:phase=="first" ? 1.5:6,prepare:{_ in prepares+=1;return AgentSessionPreparation(projectID:id,provider:"codebuddy",launch:launch)})
 let rev=(before["revision"] as! NSNumber).intValue,request="request_"+phase
 let first=phase=="first"
 let state=try store.startGeneration(projectID:id,requestID:request,expectedRevision:rev,replaceExisting:true,
    generationMode:first ? "new":"resume",snapshot:first ? ["provider":"codebuddy","items":[resource,reviewResource]]:nil)
 let base=(state["revision"] as! NSNumber).intValue
 var material=resource as [String:Any]
 material["format"]="document"
 material["segments"]=[["id":"s1","location":["kind":"section","index":1],"text":"Practice with a fresh CSV input and verify the report totals."]] as [[String:Any]]
 let reviewMaterial=material.merging(reviewResource){_,new in new}
 var context=state;context["materialSources"]=[material,reviewMaterial]
 let persistent=["pause-repair","resume-repair","wide-repair"].contains(phase)
 let job=try manager.begin(projectID:id,intent:"generate",context:context,saveProgress:{progress in
  _ = try store.saveGenerationProgress(projectID:id,progress:progress,requestID:request,baseRevision:base)
 },saveRevision:persistent ? {patch in
  _ = try store.saveGenerationRevision(projectID:id,patch:patch,requestID:request,baseRevision:base)
 }:nil,validateRoute:{route in
  let details=try store.agentRouteDiagnostics(projectID:id,route:route);if !(details["issues"] as! [[String:String]]).isEmpty{throw PlanningError.route}
 }){value in
  applications+=1
  if failCommit{throw PlanningError.storage}
  let revised=value["revisedLessons"] as? [String] ?? [],renamed=value["renamedLessons"] as? [String] ?? []
  let expectedRevised=persistent ? []:phase=="second-blocker" ? ["node_1_4","node_2_1"]:["node_1_4"]
  check(revised==expectedRevised,"save callback did not receive the reviewed revision's exact scope")
  check(renamed==(phase=="rename" ? ["node_1_4"]:[]),"title changes were not authorized exactly")
  let links=value["materialLinks"] as? [[String:String]] ?? []
  check(links==[expectedLink,expectedReviewLink],"save callback did not preserve the draft link and add the reviewed chapter link")
  return try store.applyGenerated(projectID:id,route:value["route"] as! [String:Any],requestID:request,baseRevision:base,revisedLessons:revised,renamedLessons:renamed,materialLinks:links)
 }
 let jobID=job["id"] as! String
 var result:[String:Any]=[:],cancelled=false;let end=Date().addingTimeInterval(10)
 repeat{
  result=try manager.state(projectID:id,jobID:jobID)
  if phase=="cancel-review",!cancelled,(try requestRecords()).contains(where:{$0["phase"] as? String==phase}){try manager.cancel(projectID:id,jobID:jobID);cancelled=true}
  if result["state"] as? String != "pending"{break};Thread.sleep(forTimeInterval:0.02)
 }while Date()<end
 manager.shutdown()
 check(prepares==1,"cached candidate bypassed review or wrong prepare count")
 check(applications==(["second","rename","second-blocker","remaining-blocker","resume-repair","wide-repair"].contains(phase) ? 1:0),"unexpected apply callback count for \\(phase): \\(applications)")
 return result
}
let firstStore=try store(),before=try firstStore.read(projectID:id)!,old=try JSONSerialization.data(withJSONObject:before["routeDraft"]!,options:.sortedKeys)
let first=try run("first",firstStore,before);check(first["errorCode"] as? String=="PLANNING_AGENT_TIMEOUT" && (first["diagnostic"] as? [String:Any])?["stage"] as? String=="idle_timeout","first request did not time out on output silence: \\(first)")
let saved=try firstStore.read(projectID:id)!,draft=saved["generationDraft"] as! [String:Any],parts=draft["chapters"] as! [Any]
check((parts[0] as! [String:Any])["nodes"] as? [[String:Any]] != nil,"first batch not saved")
check(((parts[0] as! [String:Any])["nodes"] as! [[String:Any]]).count==3,"incomplete batch was saved")
check((parts[0] as! [String:Any])["materialLinks"] as? [[String:String]]==[expectedLink],"reference was not saved with the first batch")
let firstDiagnostic=first["diagnostic"] as! [String:Any]
let savedLessonCount=parts.compactMap{$0 as? [String:Any]}.reduce(0){$0+(($1["nodes"] as? [[String:Any]])?.count ?? 0)}
check(firstDiagnostic["completedLessons"] as? Int==savedLessonCount && firstDiagnostic["lessonCount"] as? Int==6,"partial progress does not match saved lessons")
check(try JSONSerialization.data(withJSONObject:saved["routeDraft"]!,options:.sortedKeys)==old,"timeout replaced old route")
let secondStore=try store(),recovered=try secondStore.read(projectID:id)!;check(recovered["pending"]==nil,"restart did not recover pending")
let second=try run("second",secondStore,recovered,true);check(second["errorCode"] as? String=="PLANNING_STORAGE_UNAVAILABLE","commit fixture did not fail: \\(second)")
let secondDiagnostic=second["diagnostic"] as! [String:Any]
check(secondDiagnostic["completedLessons"] as? Int==6 && secondDiagnostic["lessonCount"] as? Int==6,"resumed progress omitted saved lessons")
let complete=try secondStore.read(projectID:id)!;check(try JSONSerialization.data(withJSONObject:complete["routeDraft"]!,options:.sortedKeys)==old,"failed final commit replaced route")
let originalCheckpoint=try JSONSerialization.data(withJSONObject:complete["generationDraft"]!,options:.sortedKeys)
for phase in ["cancel-review","global","unknown","duplicate","mismatch","malformed","invalid-revision","invalid-rename","no-op","repeat","summary","unsafe-summary","long-summary"]{
 let failedStore=try store(),pending=try failedStore.read(projectID:id)!,result=try run(phase,failedStore,pending)
 check(result["state"] as? String==(phase=="cancel-review" ? "cancelled":"failed") && result["result"]==nil,"unreviewed candidate was committed: \\(phase) \\(result)")
 if phase != "cancel-review"{check(result["errorCode"] as? String=="PLANNING_AGENT_QUALITY_REVIEW","expected a quality-specific error: \\(phase) \\(result)")}
 let summary=result["qualitySummary"] as? [String:String]
 if phase=="summary"{check(summary==["text":"The practice asks learners to record the starting balance after placing an order.","locale":"en"],"concise learner summary missing")}
 else{check(summary==nil,"unsafe or absent summary reached the UI")}
 if ["summary","unsafe-summary","long-summary"].contains(phase){check(result["qualityReason"] as? String=="practice_sequence","first blocking reason was not forwarded")}
 check(result["restartGeneration"]==nil,"review failure forced regeneration")
 if ["cancel-review","unknown","duplicate","mismatch","malformed"].contains(phase){check(result["qualityReason"]==nil,"unverified reason reached the UI")}
 check(result["qualityIssues"]==nil && result["userReply"]==nil && result["partialReply"]==nil,"internal review details reached the UI")
 let diagnostic=result["diagnostic"] as? [String:Any]
 check(diagnostic?["qualityReason"]==nil && diagnostic?["qualitySummary"]==nil,"review content leaked into diagnostics")
 let preserved=try failedStore.read(projectID:id)!
 check(try JSONSerialization.data(withJSONObject:preserved["routeDraft"]!,options:.sortedKeys)==old,"quality failure replaced old route")
 check(try JSONSerialization.data(withJSONObject:preserved["generationDraft"]!,options:.sortedKeys)==originalCheckpoint,"quality failure changed saved generation batches")
}
let finalStore=try store(),ready=try finalStore.read(projectID:id)!,final=try run("rename",finalStore,ready)
check(final["state"] as? String=="completed","full cache could not finish: \\(final)")
let applied=try finalStore.read(projectID:id)!,route=applied["routeDraft"] as! [String:Any]
check(applied["generationDraft"]==nil && applied["pending"]==nil && applied["step"] as? String=="editor","final commit was not atomic")
check(route["id"] as? String==draft["routeId"] as? String,"route id changed on resume")
let savedMaterials=applied["routeMaterials"] as? [[String:Any]]
check(savedMaterials?.count==1 && savedMaterials?.first?["routeId"] as? String==route["id"] as? String &&
 savedMaterials?.first?["links"] as? [[String:String]]==[expectedLink,expectedReviewLink],"reviewed route references were not saved")
let finalNodes=(route["chapters"] as! [[String:Any]]).flatMap{$0["nodes"] as! [[String:Any]]}
check(finalNodes[3]["activities"] as? [String]==["Calculate the median of the supplied CSV values 3, 5 and 7."],"reviewed revision missing from saved route")
check(finalNodes[3]["title"] as? String=="Verify the median independently" && finalNodes[3]["id"] as? String=="node_1_4","renaming did not preserve the lesson's stable identity")
let cachedChapters=(complete["generationDraft"] as! [String:Any])["chapters"] as! [[String:Any]],cachedNodes=cachedChapters.flatMap{$0["nodes"] as! [[String:Any]]}
check(finalNodes.indices.filter{!NSDictionary(dictionary:finalNodes[$0]).isEqual(to:cachedNodes[$0])}==[3],"scoped repair changed other lessons")
try files.write(id+".json",data:JSONSerialization.data(withJSONObject:complete))
let secondBlockerStore=try store(),secondBlockerBefore=try secondBlockerStore.read(projectID:id)!
let secondBlocker=try run("second-blocker",secondBlockerStore,secondBlockerBefore)
check(secondBlocker["state"] as? String=="completed","a new localized review finding did not get one further repair")
let repairedRoute=try secondBlockerStore.read(projectID:id)!["routeDraft"] as! [String:Any]
let repairedNodes=(repairedRoute["chapters"] as! [[String:Any]]).flatMap{$0["nodes"] as! [[String:Any]]}
check(repairedNodes.indices.filter{!NSDictionary(dictionary:repairedNodes[$0]).isEqual(to:cachedNodes[$0])}==[3,5],"both rounds must preserve unaffected lessons")
try files.write(id+".json",data:JSONSerialization.data(withJSONObject:complete))
let remainingBlockerStore=try store(),remainingBlockerBefore=try remainingBlockerStore.read(projectID:id)!
let remainingBlocker=try run("remaining-blocker",remainingBlockerStore,remainingBlockerBefore)
check(remainingBlocker["state"] as? String=="completed","the review blocked a scoped repair of a remaining problem")
let finalPracticeRoute=try remainingBlockerStore.read(projectID:id)!["routeDraft"] as! [String:Any]
let practiceNodes=(finalPracticeRoute["chapters"] as! [[String:Any]]).flatMap{$0["nodes"] as! [[String:Any]]}
check(practiceNodes.indices.filter{!NSDictionary(dictionary:practiceNodes[$0]).isEqual(to:cachedNodes[$0])}==[3],"a second scoped repair changed unrelated lessons")
try files.write(id+".json",data:JSONSerialization.data(withJSONObject:complete))
let pausedStore=try store(),beforePause=try pausedStore.read(projectID:id)!,paused=try run("pause-repair",pausedStore,beforePause)
check(paused["errorCode"] as? String=="PLANNING_AGENT_QUALITY_REVIEW","the unresolved repair did not pause")
let partiallyRevised=try pausedStore.read(projectID:id)!
check(try JSONSerialization.data(withJSONObject:partiallyRevised["routeDraft"]!,options:.sortedKeys)==old,"a partial repair replaced the live route")
let partialDraft=partiallyRevised["generationDraft"] as! [String:Any]
check(partialDraft["revisedLessonIds"] as? [String]==["node_2_1"],"an invalid repair stopped other lessons from being saved")
let reopenedStore=try store(),beforeResume=try reopenedStore.read(projectID:id)!
check(beforeResume["pending"]==nil,"pending repair was not recovered on reopen")
let savedRepair=try run("resume-repair",reopenedStore,beforeResume)
check(savedRepair["state"] as? String=="completed","continuing repair failed to use its saved changes")
let repairedState=try reopenedStore.read(projectID:id)!,completeRepair=repairedState["routeDraft"] as! [String:Any]
check(repairedState["generationDraft"]==nil && repairedState["step"] as? String=="editor","the reviewed repair did not replace the draft atomically")
let completeRepairNodes=(completeRepair["chapters"] as! [[String:Any]]).flatMap{$0["nodes"] as! [[String:Any]]}
check(completeRepairNodes.indices.filter{!NSDictionary(dictionary:completeRepairNodes[$0]).isEqual(to:cachedNodes[$0])}==[3,5],"the repair changed unrelated lessons across reopen")
var wide=complete,wideDraft=complete["generationDraft"] as! [String:Any]
var wideOutline=wideDraft["outline"] as! [String:Any],wideResult=wideOutline["result"] as! [String:Any]
var wideOutlineChapters=wideResult["chapters"] as! [[String:Any]],wideChapters=wideDraft["chapters"] as! [[String:Any]]
var wideLessons=wideOutlineChapters[0]["lessons"] as! [[String:Any]],wideNodes=wideChapters[0]["nodes"] as! [[String:Any]]
for offset in 6...13{
 let title="Concept \\(offset)",id="node_1_\\(offset)"
 wideLessons.append(["title":title,"focus":"Apply the concept independently."])
 var node=wideNodes[0];node["id"]=id;node["title"]=title
 node["objectives"]=[["id":id+"_o1","description":"Apply the named concept in a practice case."]]
 wideNodes.append(node)
}
wideOutlineChapters[0]["lessons"]=wideLessons;wideChapters[0]["nodes"]=wideNodes
wideResult["chapters"]=wideOutlineChapters;wideOutline["result"]=wideResult
wideDraft["outline"]=wideOutline;wideDraft["chapters"]=wideChapters;wide["generationDraft"]=wideDraft
try files.write(id+".json",data:JSONSerialization.data(withJSONObject:wide))
let wideStore=try store(),beforeWide=try wideStore.read(projectID:id)!,repairedWide=try run("wide-repair",wideStore,beforeWide)
check(repairedWide["state"] as? String=="completed","a review affecting thirteen lessons was not repaired")
let requests=try requestRecords()
let wideBatches=requests.filter{$0["phase"] as? String=="wide-repair" && $0["stage"] as? String=="revision"}
check(wideBatches.compactMap{$0["refs"] as? [String]}.flatMap{$0}==(1...13).map{"L\\($0)"},"wide repair skipped or repeated lessons")
for phase in ["second-blocker","remaining-blocker"]{
 let stages=requests.filter{$0["phase"] as? String==phase}.map{$0["stage"] as! String}
 check(stages==["review","revision","review","revision","review"],"blockers were not handled in exactly one further pass: \\(phase)")
}
let resumed=requests.filter{$0["phase"] as? String=="second"};check(resumed.map{$0["stage"] as! String}==["lessons","review"] && resumed[0]["refs"] as? [String]==["L4","L5"],"resumed completed work: \\(resumed)")
for phase in ["global","repeat","unknown","duplicate","mismatch","malformed","invalid-revision","invalid-rename","no-op","rename","summary","unsafe-summary","long-summary"]{
 let calls=requests.filter{$0["phase"] as? String==phase},stages=calls.map{$0["stage"] as! String}
 if phase=="rename"{check(stages==["review","revision","review"],"expected one local correction and full re-review: \\(calls)")}
 else if ["summary","unsafe-summary","long-summary"].contains(phase){check(stages==["review","revision","review","review"],"did not try to locate the remaining problems: \\(phase) \\(calls)")}
 else if phase=="repeat"{check(stages==["review","revision","review","revision"],"unchanged second repair was re-reviewed or applied")}
 else if phase=="global"{check(stages==["review","review"],"unscoped issue was not localized before pausing")}
 else if phase=="no-op"{check(stages==["review","revision","revision"],"unchanged revision exhausted the wrong number of attempts")}
 else if ["invalid-revision","invalid-rename"].contains(phase){check(stages.first=="review" && stages.count==5 && stages.dropFirst().allSatisfy{$0=="revision"},"invalid revisions escaped their bounded repair attempts")}
 else{check(!stages.isEmpty && stages.count<=2 && stages.allSatisfy{$0=="review"},"malformed review retries escaped")}
}
func envelope(_ result:[String:Any])->[String:Any]{["status":"ok","reply":"Review complete.","result":result,"missing":[]]}
func widePlan(_ count:Int)throws->PlanningGeneration.Plan{
 let lessons=(1...count).map{["title":"Concept \\($0)","focus":"Apply the concept."]}
 return try PlanningGeneration.plan(envelope(["title":"Practice","chapters":[["title":"Concepts","stageGoal":"Apply concepts independently.","lessons":lessons]]]),locale:"en")
}
func scope(_ refs:[String],_ count:Int)throws->[PlanningGeneration.QualityTarget]{
 let blocker:[String:Any]=["code":"alignment","targetRefs":refs,"message":"Practice input is missing.","fixHint":"Supply a concrete practice input.","blocking":true]
 let plan=try widePlan(count)
 return try PlanningGeneration.review(envelope(["ready":false,"issues":[blocker]]),plan:plan).targets(in:plan)
}
check(try scope(["C1"],13).map(\\.range)==[0..<3,3..<6,6..<9,9..<12,12..<13],"chapter expansion skipped lessons past the first twelve")
check(try scope(["L1","L3","L5","L7","L9","L11","L13"],13).count==7,"scattered problems past the first six were skipped")
let assessmentBlocker:[String:Any]=["code":"assessment_invalid","targetRefs":["L2"],"message":"The public criterion gives the answer.","fixHint":"Keep it in the grader only.","blocking":true]
let practicePlan=try widePlan(3),assessmentOnly=try PlanningGeneration.review(envelope(["ready":false,"issues":[assessmentBlocker]]),plan:practicePlan)
check(assessmentOnly.targets(in:practicePlan,attempts:["L2/alignment":2]).first?.range==1..<2,"repairing another problem exhausted the assessment attempts")
check(assessmentOnly.targets(in:practicePlan,attempts:["L2/assessment_invalid":2]).isEmpty,"a repeated assessment issue did not pause")
print("PASS durable timeout, restarted quality gate, scoped revision, re-review and atomic apply")
`);
 const compile=spawnSync('/usr/bin/swiftc',['-module-cache-path','tmp/cache/swift','apps/macos/RuntimeDirectory.swift','apps/macos/AgentManager.swift','apps/macos/CodeBuddyAdapter.swift','apps/macos/PlanningPromptPackResources.swift','apps/macos/PlanningPromptPack.swift','apps/macos/PlanningStore.swift','apps/macos/PlanningAgent.swift','apps/macos/PlanningGeneration.swift',source,'-o',binary],{encoding:'utf8',timeout:200000});await writeFile(join(dir,'compile.log'),compile.stdout+compile.stderr);assert.equal(compile.status,0,compile.stderr);
 const run=spawnSync(binary,[join(dir,'data'),fixture,validator,initial],{encoding:'utf8',timeout:45000});await writeFile(join(dir,'run.log'),run.stdout+run.stderr);assert.equal(run.status,0,run.stderr);assert.match(run.stdout,/PASS durable/);console.log('Resume evidence: '+dir);
});
