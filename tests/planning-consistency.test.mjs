import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {build} from 'esbuild';
import {createPlanning,appendUser,applyInterview,acceptAnswer,reanswerQuestion,cancelAnswerDraft,canGenerate,canRequestGeneration,needsConsistencyCheck,planningFacts,planningFactsHash,consistencyReady,beginConsistencyCheck,applyConsistencyCheck,acceptConsistencySuggestion,setResources,setAgentOptions,focusQuestion,startGeneration,applyGenerated,cancelPlanningRequest,recoverPlanning,validatePlanning,upgradeRoute} from '../packages/domain/planning.mjs';

const project='proj_12345678-1234-4234-8234-123456789abc',now='2026-11-04T08:00:00.000Z';
const compatible={status:'consistent',issues:[]};
const answers={goal:{topic:'机器学习',outcome:'独立训练图像分类器'},purpose:{context:'解释一项模型训练实验',criteria:'报告图像分类准确率和错分案例'},baseline:{experience:'用过Python，做过图像分类练习'},time:{weekly:'每周5小时',session:'每次30分钟'},constraints:{scope:'实现小型模型',conditions:'只有现有电脑'}};
const languageGoal={topic:'字符级语言模型',outcome:'训练字符级语言模型并展示文本采样'};
const review=()=>({status:'requires_review',issues:[{questionId:'purpose',fields:['criteria'],kind:'incompatible',reason:'新的成果是语言模型，旧标准仍只评估图像分类。',suggestion:{summary:'展示字符级语言模型采样，并说明训练表现及局限。',fields:{criteria:'展示文本采样，并根据训练/验证损失说明表现和局限'}}}]});
function proposal(state,id,fields,assessment=compatible,complete=true){
 if(state.questions.find(q=>q.id===id).acceptedSnapshot)state=reanswerQuestion(state,id,state.revision);
 else if(state.currentQuestion!==id)state=focusQuestion(state,id,state.revision);
 const request=`r_${state.revision}_${id}`,message=`u_${state.revision}_${id}`;
 state=appendUser(state,JSON.stringify(fields),message,request,state.revision,now);
 const result={reply:'请核对本题总结。',summary:Object.values(fields).join(' / '),updates:[{id,fields,evidence:Object.keys(fields).map(field=>({field,messageId:message,quote:'合成用户提供了这些事实。'})),missing:complete?[]:['还有一个必要问题。'],complete}]};
 if(assessment!==null)result.consistency=assessment;
 return applyInterview(state,result,request,state.revision,now);
}
function adopt(state,id){return acceptAnswer(state,id,state.questions.find(q=>q.id===id).answerProposal.messageId,state.revision)}
function completed(assessment=compatible){let state=createPlanning(project,'codex','zh-CN');for(const [id,fields] of Object.entries(answers))state=adopt(proposal(state,id,fields,assessment),id);return state}
function preflight(state,assessment=compatible,request=`check_${state.revision}`){state=beginConsistencyCheck(state,request,state.revision);return applyConsistencyCheck(state,{reply:'已检查当前背景。',consistency:assessment},request,state.revision,now)}
const rawRoute=JSON.parse(await readFile('contracts/examples/route.valid.json','utf8'));
function withOldRoute(state){const route=upgradeRoute(rawRoute);for(const chapter of route.chapters)chapter.stageGoal='独立解释并完成本阶段任务。';state=structuredClone(state);state.routeDraft=route;state.confirmedRevision=route.revision;return validatePlanning(state)}

test('a candidate and its cross-answer assessment remain isolated until explicit adoption',()=>{
 const old=completed(),hash=planningFactsHash(old),epoch=old.backgroundEpoch;
 let state=proposal(old,'goal',languageGoal,review());
 assert.deepEqual(state.questions[0].acceptedSnapshot.fields,answers.goal);
 assert.deepEqual(state.questions[0].fields,languageGoal);
 assert.equal(state.questions[1].status,'complete');assert.equal(state.consistency.issues.length,0);
 assert.equal(planningFactsHash(state),hash);assert.equal(state.backgroundEpoch,epoch);assert.equal(canGenerate(state),false);
 state=adopt(state,'goal');
 assert.deepEqual(state.questions[0].acceptedSnapshot.fields,languageGoal);assert.equal(state.questions[0].status,'complete');
 assert.equal(state.questions[1].status,'needs-review');assert.deepEqual(state.questions[1].fields,answers.purpose);
 assert.deepEqual(state.questions[2].acceptedSnapshot.fields,answers.baseline);assert.deepEqual(state.questions[3].fields,answers.time);
 assert.equal(state.backgroundEpoch,epoch+1);assert.notEqual(planningFactsHash(state),hash);
 assert.equal(state.consistency.anchorQuestionId,'goal');assert.equal(state.currentQuestion,'purpose');
 assert.equal(canRequestGeneration(state),false);assert.equal(canGenerate(state),false);
 assert.match(state.consistency.issues[0].id,/^issue_\d+_1$/);
 assert.deepEqual(validatePlanning(JSON.parse(JSON.stringify(state))),state);
});

test('adopting a synchronization suggestion preserves unrelated facts and records a real action, then requires one preflight',()=>{
 let state=adopt(proposal(completed(),'goal',languageGoal,review()),'goal');
 const id=state.consistency.issues[0].id,oldMessages=structuredClone(state.messages),oldBaseline=structuredClone(state.questions[2]),epoch=state.backgroundEpoch;
 state=acceptConsistencySuggestion(state,id,state.revision,now);
 assert.equal(state.questions[1].fields.context,answers.purpose.context);
 assert.equal(state.questions[1].fields.criteria,review().issues[0].suggestion.fields.criteria);
 assert.deepEqual(state.questions[2],oldBaseline);assert.deepEqual(state.messages,oldMessages);
 assert.equal(state.answerEvents.length,1);assert.equal(state.answerEvents[0].kind,'suggestion');assert.equal(state.answerEvents[0].issueId,id);
 const evidence=state.questions[1].evidence.find(item=>item.field==='criteria');
 assert.equal(evidence.messageId,undefined);assert.equal(evidence.acceptanceEventId,state.answerEvents[0].id);
 assert.equal(state.backgroundEpoch,epoch+1);assert.equal(state.consistency.anchorQuestionId,'goal');
 assert.equal(canRequestGeneration(state),true);assert.equal(needsConsistencyCheck(state),true);assert.equal(canGenerate(state),false);
 assert.throws(()=>acceptConsistencySuggestion(state,id,state.revision,now),/CONFLICT/);
 state=preflight(state);assert.equal(canGenerate(state),true);assert.equal(consistencyReady(state),true);
 assert.equal(state.consistency.factsHash,planningFactsHash(state));assert.deepEqual(state.messages,oldMessages);
});

test('unadopted drafts can be cancelled without corrupting the old accepted receipt or facts',()=>{
 const old=completed(),hash=planningFactsHash(old),epoch=old.backgroundEpoch;
 let state=proposal(old,'goal',languageGoal,compatible,false);
 assert.deepEqual(state.questions[0].acceptedSnapshot,old.questions[0].acceptedSnapshot);
 assert.equal(state.questions[0].status,'needs-detail');assert.equal(planningFactsHash(state),hash);
 state=cancelAnswerDraft(state,'goal',state.revision);
 assert.deepEqual(state.questions[0].fields,answers.goal);assert.equal(state.backgroundEpoch,epoch);assert.equal(canGenerate(state),true);
});

test('stale assessment bindings are rejected when other background facts change before adoption',()=>{
 let state=proposal(completed(),'goal',languageGoal,compatible);
 const message=state.questions[0].answerProposal.messageId;
 state=setResources(state,'Only an offline text sample is available.',state.revision);
 const before=structuredClone(state);
 assert.throws(()=>acceptAnswer(state,'goal',message,state.revision),/CONFLICT/);assert.deepEqual(state,before);
 assert.deepEqual(state.questions[0].acceptedSnapshot.fields,answers.goal);assert.deepEqual(state.questions[0].fields,languageGoal);
});

test('equal wording still gets a new answer revision and epoch, preventing ABA receipt reuse',()=>{
 const first=completed(),oldHash=planningFactsHash(first),oldReceipt=structuredClone(first.consistency);
 let state=adopt(proposal(first,'goal',answers.goal,compatible),'goal');
 assert.deepEqual(state.questions[0].fields,first.questions[0].fields);
 assert.equal(state.questions[0].acceptedSnapshot.revision,first.questions[0].acceptedSnapshot.revision+1);
 assert.equal(state.backgroundEpoch,first.backgroundEpoch+1);assert.notEqual(planningFactsHash(state),oldHash);assert.equal(canGenerate(state),true);
 const forged=structuredClone(state);forged.consistency=oldReceipt;assert.throws(()=>validatePlanning(forged),/INVALID/);
});

test('legacy complete projects remain readable and receive a single preflight without losing old routes or answers',()=>{
 let legacy=withOldRoute(completed());delete legacy.consistency;delete legacy.backgroundEpoch;for(const q of legacy.questions)delete q.acceptedSnapshot;
 const before=structuredClone(legacy);validatePlanning(legacy);
 assert.equal(canRequestGeneration(legacy),true);assert.equal(needsConsistencyCheck(legacy),true);assert.equal(canGenerate(legacy),false);
 assert.throws(()=>startGeneration(legacy,'old_gen',legacy.revision),/INCOMPLETE/);
 legacy=preflight(legacy);
 assert.equal(canGenerate(legacy),true);assert.deepEqual(legacy.routeDraft,before.routeDraft);assert.equal(legacy.confirmedRevision,before.confirmedRevision);
 assert.deepEqual(legacy.messages,before.messages);
 for(const [index,q] of legacy.questions.entries()){assert.deepEqual(q.fields,before.questions[index].fields);assert.equal(q.acceptedSnapshot.revision,0)}
});

test('preflight cancellation and restart preserve adopted facts, do not replay and never create a receipt',()=>{
 const initial=completed(null),hash=planningFactsHash(initial);
 let state=beginConsistencyCheck(initial,'interrupted_check',initial.revision),base=state.revision;
 state=recoverPlanning(state,now);assert.equal(state.pending,undefined);assert.equal(planningFactsHash(state),hash);assert.equal(canGenerate(state),false);
 assert.throws(()=>applyConsistencyCheck(state,{reply:'Late response',consistency:compatible},'interrupted_check',base,now),/CONFLICT/);
 state=beginConsistencyCheck(state,'cancelled_check',state.revision);state=cancelPlanningRequest(state,'cancelled_check',state.revision);
 assert.equal(canRequestGeneration(state),true);assert.equal(canGenerate(state),false);
});

test('generation-discovered conflicts use the same review state and cannot replace the previous route',()=>{
 let state=withOldRoute(completed()),oldRoute=structuredClone(state.routeDraft),confirmation=state.confirmedRevision;
 state=startGeneration(state,'late_conflict',state.revision);
 assert.throws(()=>applyConsistencyCheck(state,{reply:'Fine',consistency:compatible},'late_conflict',state.revision,now),/RESPONSE/);
 const generationRevision=state.revision;
 state=applyConsistencyCheck(state,{reply:'The old success standard needs review.',consistency:review()},'late_conflict',state.revision,now);
 assert.equal(state.pending,undefined);assert.equal(state.questions[1].status,'needs-review');assert.deepEqual(state.routeDraft,oldRoute);assert.equal(state.confirmedRevision,confirmation);
 assert.throws(()=>applyGenerated(state,oldRoute,'late_conflict',generationRevision),/CONFLICT/);
});

test('policy updates require a preflight, while focus and model options do not change the facts epoch',()=>{
 const original=completed();let state=focusQuestion(original,'goal',original.revision);
 state=setAgentOptions(state,{model:'synthetic-model',effort:'high'},state.revision);
 assert.equal(state.backgroundEpoch,original.backgroundEpoch);assert.equal(planningFactsHash(state),planningFactsHash(original));assert.equal(canGenerate(state),true);
 state=structuredClone(state);state.consistency.version='answer-consistency.v0';validatePlanning(state);
 assert.equal(needsConsistencyCheck(state),true);state=preflight(state);assert.equal(canGenerate(state),true);
});

test('unknown question/field targets and invalid synchronization proposals are atomic failures',()=>{
 for(const mutation of [issue=>{issue.questionId='password'},issue=>{issue.fields=['experience']},issue=>{issue.suggestion.fields={context:'invented unrelated context'}}]){
  const assessment=review();mutation(assessment.issues[0]);const state=completed(),before=structuredClone(state);
  assert.throws(()=>proposal(state,'goal',languageGoal,assessment),/RESPONSE/);assert.deepEqual(state,before);
 }
 const state=adopt(proposal(completed(),'goal',languageGoal,review()),'goal'),before=structuredClone(state);
 assert.throws(()=>acceptConsistencySuggestion(state,'model_supplied_id',state.revision,now),/CONFLICT/);assert.deepEqual(state,before);
});

test('multiple reviewed suggestions can be adopted without extra model calls, but final facts remain unchecked',()=>{
 const assessment=review();assessment.issues.push({questionId:'constraints',fields:['scope'],kind:'uncertain',reason:'需要说明本次小模型的范围。',suggestion:{summary:'保持现有电脑，限定为小型字符模型。',fields:{scope:'只实现小型字符模型'}}});
 let state=adopt(proposal(completed(),'goal',languageGoal,assessment),'goal');
 const ids=state.consistency.issues.map(issue=>issue.id);state=acceptConsistencySuggestion(state,ids[0],state.revision,now);
 assert.equal(state.questions[4].status,'needs-review');assert.equal(canRequestGeneration(state),false);
 state=acceptConsistencySuggestion(state,ids[1],state.revision,now);
 assert.equal(state.answerEvents.length,2);assert.equal(state.questions[4].fields.conditions,answers.constraints.conditions);
 assert.equal(canRequestGeneration(state),true);assert.equal(canGenerate(state),false);assert.equal(canGenerate(preflight(state)),true);
});

test('facts hashes cover accepted summaries, versions and resources without draft/model/UI state',()=>{
 const state=completed(),facts=planningFacts(state);assert.deepEqual(Object.keys(facts.answers),Object.keys(answers));assert.equal(facts.resources,'');
 const resources=setResources(state,'Selected source notes',state.revision);
 assert.notEqual(planningFactsHash(resources),planningFactsHash(state));assert.equal(canRequestGeneration(resources),true);assert.equal(canGenerate(resources),false);
 assert.deepEqual(resources.questions,state.questions);assert.equal(resources.consistency.anchorQuestionId,state.consistency.anchorQuestionId);assert.equal(resources.consistency.anchorRevision,state.consistency.anchorRevision);
});

test('unrelated resources invalidate the receipt while preserving unresolved reviews, suggestions and the adopted anchor',()=>{
 const before=adopt(proposal(completed(),'goal',languageGoal,review()),'goal'),issues=structuredClone(before.consistency.issues);
 const state=setResources(before,'An unrelated introductory reading list',before.revision);
 assert.deepEqual(state.questions,before.questions);assert.deepEqual(state.consistency.issues,issues);
 assert.equal(state.questions[1].status,'needs-review');assert.deepEqual(state.questions[1].fields,answers.purpose);
 assert.equal(state.consistency.status,'requires_review');assert.equal(state.consistency.anchorQuestionId,'goal');assert.equal(state.consistency.anchorRevision,before.consistency.anchorRevision);
 assert.equal(state.backgroundEpoch,before.backgroundEpoch+1);assert.notEqual(planningFactsHash(state),planningFactsHash(before));assert.equal(state.consistency.factsHash,planningFactsHash(state));
 assert.equal(canRequestGeneration(state),false);assert.equal(canGenerate(state),false);
});

test('editing a reviewed answer, saving resources and choosing Keep original restores its unresolved review',()=>{
 const before=adopt(proposal(completed(),'goal',languageGoal,review()),'goal');
 let state=reanswerQuestion(before,'purpose',before.revision);state=setResources(state,'An unrelated introductory reading list',state.revision);
 assert.equal(state.questions[1].status,'current');assert.deepEqual(state.questions[1].fields,{});assert.deepEqual(state.consistency.issues,before.consistency.issues);
 state=cancelAnswerDraft(state,'purpose',state.revision);
 assert.equal(state.questions[1].status,'needs-review');assert.deepEqual(state.questions[1].fields,answers.purpose);assert.deepEqual(state.consistency.issues,before.consistency.issues);
 assert.equal(state.consistency.anchorQuestionId,'goal');assert.equal(canRequestGeneration(state),false);assert.equal(canGenerate(state),false);
});

test('a newly adopted full assessment can resolve the review preserved across a resources edit',()=>{
 const before=adopt(proposal(completed(),'goal',languageGoal,review()),'goal');
 let state=setResources(before,'An unrelated introductory reading list',before.revision);
 const fields={...answers.purpose,...review().issues[0].suggestion.fields};state=adopt(proposal(state,'purpose',fields,compatible),'purpose');
 assert.equal(state.questions[1].status,'complete');assert.equal(state.consistency.issues.length,0);assert.equal(canGenerate(state),true);
 assert.deepEqual(state.questions[0].acceptedSnapshot,before.questions[0].acceptedSnapshot);assert.deepEqual(state.questions[2].acceptedSnapshot,before.questions[2].acceptedSnapshot);
});

test('JavaScriptCore and PlanningStore preserve review actions, hashes and receipts across restart',{skip:process.platform!=='darwin',timeout:180_000},async()=>{
 const parent=resolve('tmp/checks/answer-consistency-2026-11-04');await mkdir(parent,{recursive:true});const dir=await mkdtemp(join(parent,'domain-native-'));
 const fixture=join(dir,'state.json'),validator=join(dir,'planning.js'),source=join(dir,'main.swift'),binary=join(dir,'verify');
 const initial=adopt(proposal(completed(),'goal',languageGoal,review()),'goal');
 await writeFile(fixture,JSON.stringify(initial));
 await build({entryPoints:['packages/domain/planning.mjs'],bundle:true,format:'iife',globalName:'VibePlanning',platform:'neutral',target:'es2022',outfile:validator,logLevel:'silent'});
 await writeFile(source,`import Foundation
import JavaScriptCore
func check(_ value:Bool,_ note:String){if !value{fputs(note+"\\n",stderr);exit(1)}}
let base=URL(fileURLWithPath:CommandLine.arguments[1]),validator=URL(fileURLWithPath:CommandLine.arguments[2]),fixture=URL(fileURLWithPath:CommandLine.arguments[3])
let runtime=try RuntimeDirectory(url:base.appendingPathComponent("runtime")),workspace=base.appendingPathComponent("workspace")
try FileManager.default.createDirectory(at:workspace,withIntermediateDirectories:true)
let files=try runtime.child("projects").child("planning"),id="${project}"
func save(_ state:[String:Any])throws{try files.write(id+".json",data:JSONSerialization.data(withJSONObject:state,options:.sortedKeys))}
let js=JSContext()!;js.evaluateScript("Object.hasOwn = Object.hasOwn || ((o,k)=>Object.prototype.hasOwnProperty.call(o,k));");js.evaluateScript(try String(contentsOf:validator,encoding:.utf8))
func run(_ name:String,_ args:[Any])throws->[String:Any]{let value=js.objectForKeyedSubscript("VibePlanning")?.objectForKeyedSubscript(name)?.call(withArguments:args);check(js.exception==nil,"JS domain call failed: "+name);return value!.toDictionary() as! [String:Any]}
var state=try JSONSerialization.jsonObject(with:Data(contentsOf:fixture)) as! [String:Any];try save(state)
let store=try PlanningStore(runtime:runtime,validatorURL:validator,workspace:{_ in workspace})
state=try store.read(projectID:id)!;check((state["questions"] as! [[String:Any]])[1]["status"] as? String=="needs-review","review state did not persist")
let issue=((state["consistency"] as! [String:Any])["issues"] as! [[String:Any]])[0]["id"] as! String
state=try run("acceptConsistencySuggestion",[state,issue,state["revision"]!,"${now}"]);try save(state);state=try store.read(projectID:id)!
check((state["answerEvents"] as! [[String:Any]]).count==1,"adoption event missing")
state=try run("beginConsistencyCheck",[state,"native_check",state["revision"]!]);try save(state)
check(try store.read(projectID:id)?["pending"] != nil,"same-process read interrupted an active preflight")
state=try run("applyConsistencyCheck",[state,["reply":"已检查当前背景。","consistency":["status":"consistent","issues":[]]],"native_check",state["revision"]!,"${now}"]);try save(state)
let restarted=try PlanningStore(runtime:runtime,validatorURL:validator,workspace:{_ in workspace});state=try restarted.read(projectID:id)!
check(state["pending"]==nil,"preflight pending state returned after restart")
check(js.objectForKeyedSubscript("VibePlanning")?.objectForKeyedSubscript("canGenerate")?.call(withArguments:[state]).toBool()==true,"receipt did not enable generation")
try JSONSerialization.data(withJSONObject:state,options:.sortedKeys).write(to:base.appendingPathComponent("final.json"))
print("PASS native answer consistency persistence and hash parity")
`);
 const compile=spawnSync('/usr/bin/swiftc',['-module-cache-path','tmp/cache/swift','-framework','JavaScriptCore','apps/macos/RuntimeDirectory.swift','apps/macos/PlanningStore.swift',source,'-o',binary],{encoding:'utf8',timeout:150_000});
 await writeFile(join(dir,'compile.log'),compile.stdout+compile.stderr);assert.equal(compile.status,0,compile.stderr);
 const run=spawnSync(binary,[dir,validator,fixture],{encoding:'utf8',timeout:30_000});
 await writeFile(join(dir,'run.log'),run.stdout+run.stderr);assert.equal(run.status,0,run.stderr+run.stdout);assert.match(run.stdout,/PASS native answer consistency/);
 let expected=acceptConsistencySuggestion(initial,initial.consistency.issues[0].id,initial.revision,now);expected=preflight(expected,compatible,'native_check');
 assert.deepEqual(JSON.parse(await readFile(join(dir,'final.json'),'utf8')),expected);
 console.log('Answer consistency domain evidence: '+dir);
});
