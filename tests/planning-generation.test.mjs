import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {validateRoute} from '../packages/domain/route-validation.mjs';

test('unified generation maps task references into complete host-owned routes',{skip:process.platform!=='darwin',timeout:180_000},async()=>{
  const root=resolve('tmp/checks/unified-planning-2026-11-04');await mkdir(root,{recursive:true});const dir=await mkdtemp(join(root,'generation-native-'));
  const source=join(dir,'main.swift'),binary=join(dir,'verify');
  await writeFile(source,String.raw`import Foundation
func check(_ value:Bool,_ message:String="assertion failed"){if !value{fatalError(message)}}
func rejected(_ action:()throws->Void){do{try action();fatalError("invalid generation accepted")}catch let e as PlanningOutputError{check(e.code == .rejected);check(!e.issues.isEmpty)}catch{}}
func envelope(_ result:[String:Any])->[String:Any]{["status":"ok","reply":"Please review the result.","result":result,"missing":[]]}
func outcome(_ value:[String:Any],_ task:String,_ expected:String){do{_ = try PlanningPromptPack.unwrap(value,task:task);fatalError("non-ok outcome accepted")}catch let e as PlanningTaskOutcome{check(e.code==expected && e.userReply=="More information is needed.")}catch{fatalError("outcome was not preserved")}}
let output=URL(fileURLWithPath:CommandLine.arguments[1]),marker="\nCONTEXT_JSON_DATA:\n"
let context:[String:Any]=["schemaVersion":1,"projectId":"proj_00000000-0000-4000-8000-000000000123","revision":15,"step":"intake","locale":"zh-CN","provider":"codebuddy","questions":[["id":"goal","status":"complete","summary":"SENSITIVE_CONFIRMED_TOPIC","fields":["topic":"SENSITIVE_CONFIRMED_TOPIC"],"evidence":["SENSITIVE_EVIDENCE"]],["id":"time","status":"awaiting-confirmation","summary":"SENSITIVE_UNADOPTED_SUMMARY","fields":["session":"SENSITIVE_UNADOPTED_FIELD"],"answerProposal":["summary":"SENSITIVE_UNADOPTED_PROPOSAL"]]],"messages":[["role":"assistant","text":"SENSITIVE_OLD_CONVERSATION"]],"routeDraft":["title":"SENSITIVE_OLD_ROUTE"]]
let lesson:[String:Any]=["title":"Trace a tensor shape","focus":"Trace a named example and explain the dimensions."]
let first:[String:Any]=["title":"Tensor operations","stageGoal":"Trace tensors and explain shape changes in a small example.","lessons":[lesson,["title":"Apply indexing","focus":"Select named rows and check resulting dimensions."],["title":"Broadcast arrays","focus":"Predict compatible axes and verify numerical output."],["title":"Differentiate a function","focus":"Compute and check a gradient on a small differentiable function."]]]
let second:[String:Any]=["title":"Training updates","stageGoal":"Explain the order and effect of one complete training update.","lessons":[["title":"Apply one update","focus":"Compute a loss, clear gradients, backpropagate and update parameters."]]]
let outline:[String:Any]=["title":"Learn a small training workflow","chapters":[first,second]]
let plan=try PlanningGeneration.plan(envelope(outline),locale:"zh-CN")
check(plan.chapters.count==2 && plan.chapters[0].lessons.count==4)
check(plan.chapters[0].id=="ch_1" && plan.chapters[1].lessons[0].id=="node_2_1")
check(plan.chapters[1].lessons[0].ref=="L5" && plan.aliasToNodeID["L5"]=="node_2_1")
check(plan.reply=="Please review the result.")
check(plan.id != (try PlanningGeneration.plan(envelope(outline),locale:"zh-CN")).id,"regeneration reused route identity")
for mutation in ["extra","empty","manyChapters","manyLessons","manyNodes","emptyGoal","longGoal","extraLesson","emptyFocus","longFocus","longTitle"]{
 var value=outline
 if mutation=="extra"{value["route"]="SENSITIVE_EXTRA"}
 if mutation=="empty"{value["chapters"]=[]}
 if mutation=="manyChapters"{value["chapters"]=Array(repeating:second,count:25)}
 if mutation=="manyLessons"{var c=first;c["lessons"]=Array(repeating:lesson,count:65);value["chapters"]=[c]}
 if mutation=="manyNodes"{var c=first;c["lessons"]=Array(repeating:lesson,count:64);value["chapters"]=Array(repeating:c,count:9)}
 if mutation=="emptyGoal"{var c=first;c["stageGoal"]="  ";value["chapters"]=[c]}
 if mutation=="longGoal"{var c=first;c["stageGoal"]=String(repeating:"界",count:601);value["chapters"]=[c]}
 if mutation=="extraLesson"{var c=first,l=lesson;l["id"]="chosen_id";c["lessons"]=[l];value["chapters"]=[c]}
 if mutation=="emptyFocus"{var c=first,l=lesson;l["focus"]="";c["lessons"]=[l];value["chapters"]=[c]}
 if mutation=="longFocus"{var c=first,l=lesson;l["focus"]=String(repeating:"界",count:301);c["lessons"]=[l];value["chapters"]=[c]}
 if mutation=="longTitle"{value["title"]=String(repeating:"a",count:161)}
 rejected{_ = try PlanningGeneration.plan(envelope(value),locale:"zh-CN")}
}
var maxChapter=first;maxChapter["lessons"]=Array(repeating:lesson,count:64)
var maximum=outline;maximum["chapters"]=Array(repeating:maxChapter,count:8)
let maxPlan=try PlanningGeneration.plan(envelope(maximum),locale:"en")
check(maxPlan.orderedLessons.count==512 && maxPlan.aliasToNodeID["L512"]=="node_8_64")
for task in ["outline","lessons"]{
 outcome(["status":"needs_input","reply":"More information is needed.","result":NSNull(),"missing":["Choose a scope."]],task,"PLANNING_NEEDS_INPUT")
 outcome(["status":"cannot_complete","reply":"More information is needed.","result":NSNull(),"missing":[]],task,"PLANNING_CANNOT_COMPLETE")
 for mutation in ["legacy","missing","unknown","okNull","nonEmptyMissing","needsInputResult"]{
  var response=envelope(task=="outline" ? outline:["nodes":[]])
  if mutation=="legacy"{response=outline}
  if mutation=="missing"{response.removeValue(forKey:"missing")}
  if mutation=="unknown"{response["status"]="partial"}
  if mutation=="okNull"{response["result"]=NSNull()}
  if mutation=="nonEmptyMissing"{response["missing"]=["A required answer"]}
  if mutation=="needsInputResult"{response["status"]="needs_input";response["missing"]=["Choose scope"]}
  rejected{_ = try PlanningPromptPack.unwrap(response,task:task)}
 }
}
func promptData(_ prompt:String)throws->[String:Any]{
 let split=prompt.range(of:marker)!,data=try JSONSerialization.jsonObject(with:Data(prompt[split.upperBound...].utf8)) as! [String:Any]
 check(!String(prompt[..<split.lowerBound]).contains("SENSITIVE_"))
 return data
}
let outlinePrompt=try PlanningGeneration.outlinePrompt(context:context),outlineData=try promptData(outlinePrompt)
check(outlineData["locale"] as? String=="zh-CN")
check(outlineData["messages"]==nil && outlineData["routeDraft"]==nil && outlineData["provider"]==nil && outlineData["projectId"]==nil)
check(!outlinePrompt.contains("SENSITIVE_OLD_") && !outlinePrompt.contains("SENSITIVE_EVIDENCE") && !outlinePrompt.contains("SENSITIVE_UNADOPTED_") && outlinePrompt.contains("SENSITIVE_CONFIRMED_TOPIC"))
check((outlineData["confirmedBackground"] as! [String:Any]).count==1)
for mutation in ["locale","questionType","duplicate","unknown","invalidFields","emptySummary","badMissing","badResources"]{
 var bad=context
 if mutation=="locale"{bad["locale"]="fr"}
 if mutation=="questionType"{bad["questions"]="bad"}
 if mutation=="duplicate"{let q=(context["questions"] as! [[String:Any]])[0];bad["questions"]=[q,q]}
 if mutation=="unknown"{bad["questions"]=[["id":"unknown","status":"complete","summary":"Known","fields":["topic":"Known"]]]}
 if mutation=="invalidFields"{bad["questions"]=[["id":"goal","status":"complete","summary":"Known","fields":["session":"Known"]]]}
 if mutation=="emptySummary"{bad["questions"]=[["id":"goal","status":"complete","summary":"Known draft","fields":["topic":"Known"],"acceptedSnapshot":["revision":1,"summary":" ","fields":["topic":"Known"],"evidence":[]]]]}
 if mutation=="badMissing"{bad["questions"]=[["id":"goal","status":"complete","summary":"Known","fields":["topic":"Known"],"missing":["Unresolved"]]]}
 if mutation=="badResources"{bad["resources"]=["unexpected":"type"]}
 rejected{_ = try PlanningGeneration.outlinePrompt(context:bad)}
}
func payload(_ index:Int,_ range:Range<Int>,for selected:PlanningGeneration.Plan?=nil)->[String:Any]{
 let p=selected ?? plan
 let nodes=range.map{offset->[String:Any] in
  let target=p.chapters[index].lessons[offset],global=p.orderedLessons.firstIndex{$0.ref==target.ref}!,prior=global>0 ? p.orderedLessons[global-1].ref:nil
  return ["ref":target.ref,"objectives":["Explain and perform the named operation using a small checked example.","Diagnose a mismatch and explain the correction."],"prerequisites":prior.map{[$0]} ?? [],"estimatedMinutes":30,"activities":["Study the named example, make a prediction, perform the operation and correct discrepancies."],"assessment":NSNull()]
 }
 return envelope(["nodes":nodes])
}
func mutatedNodes(_ response:[String:Any],_ edit:(inout [[String:Any]])->Void)->[String:Any]{var response=response,result=response["result"] as! [String:Any],nodes=result["nodes"] as! [[String:Any]];edit(&nodes);result["nodes"]=nodes;response["result"]=result;return response}
let batch1=try PlanningGeneration.chapter(payload(0,0..<3),plan:plan,index:0,range:0..<3)
let firstNode=(batch1["nodes"] as! [[String:Any]])[0]
check((batch1["nodes"] as? [[String:Any]])?.count==3 && firstNode["ref"]==nil && firstNode["assessment"]==nil)
check((firstNode["objectives"] as! [[String:Any]]).map{$0["id"] as! String}==["node_1_1_o1","node_1_1_o2"])
rejected{_ = try plan.completeRoute([batch1])}
let nextPrompt=try PlanningGeneration.chapterPrompt(context:context,plan:plan,index:0,completed:[batch1],range:3..<4),nextData=try promptData(nextPrompt)
check((nextData["requestedLessons"] as! [[String:Any]]).map{$0["ref"] as! String}==["L4"])
check((nextData["availablePrerequisites"] as! [[String:Any]]).map{$0["ref"] as! String}==["L1","L2","L3"])
check(!nextPrompt.contains("Explain and perform the named operation"),"previous expanded node body leaked into prompt")
check(!nextPrompt.contains("node_1_") && !nextPrompt.contains(plan.id),"persistent IDs leaked into model wire")
check(((nextData["outline"] as! [String:Any])["chapters"] as! [[String:Any]]).count==2,"later chapter omitted from context")
check((nextData["requestedLessons"] as! [[String:Any]])[0]["focus"] as? String==plan.chapters[0].lessons[3].focus)
check(outlinePrompt.components(separatedBy:marker)[0] != nextPrompt.components(separatedBy:marker)[0],"outline and lesson task rules were not selected")
for planned in [false,true]{
 rejected{_ = try PlanningGeneration.chapterPrompt(context:context,plan:plan,index:0,completed:[],range:3..<4,plannedPrerequisites:planned)}
 rejected{_ = try PlanningGeneration.chapterPrompt(context:context,plan:plan,index:0,completed:[],range:0..<0,plannedPrerequisites:planned)}
 rejected{_ = try PlanningGeneration.chapterPrompt(context:context,plan:plan,index:0,completed:[],range:0..<4,plannedPrerequisites:planned)}
}
rejected{_ = try PlanningGeneration.chapterPrompt(context:context,plan:plan,index:1,completed:[batch1])}
rejected{_ = try PlanningGeneration.chapter(payload(0,0..<4),plan:plan,index:0,range:0..<4)}
let plannedPrompt=try PlanningGeneration.chapterPrompt(context:context,plan:plan,index:1,completed:[],plannedPrerequisites:true),plannedData=try promptData(plannedPrompt)
check((plannedData["availablePrerequisites"] as! [[String:Any]]).map{$0["ref"] as! String}==["L1","L2","L3","L4"],"planned earlier chapter prerequisites missing")
check((plannedData["requestedLessons"] as! [[String:Any]]).map{$0["ref"] as! String}==["L5"])
let plannedNext=try promptData(PlanningGeneration.chapterPrompt(context:context,plan:plan,index:0,completed:[batch1],range:3..<4,plannedPrerequisites:true))
check((plannedNext["availablePrerequisites"] as! [[String:Any]]).map{$0["ref"] as! String}==["L1","L2","L3"])
rejected{_ = try PlanningGeneration.chapterPrompt(context:context,plan:plan,index:1,completed:[],plannedPrerequisites:false)}
rejected{_ = try PlanningGeneration.chapterPrompt(context:context,plan:plan,index:1,completed:[batch1],plannedPrerequisites:true)}
var forgedPrefix=batch1,forgedNodes=batch1["nodes"] as! [[String:Any]];forgedNodes[0]["prerequisites"]=["node_2_1"];forgedPrefix["nodes"]=forgedNodes
rejected{_ = try PlanningGeneration.chapterPrompt(context:context,plan:plan,index:0,completed:[forgedPrefix],range:3..<4,plannedPrerequisites:true)}
for mutation in ["missing","extra","order","identity","title","hostID","objectiveID","future","unknown","duplicateDependency","self","missingActivities","emptyActivity","noObjectives","timeZero","timeFraction","timeBool","missingAssessment","badAssessment","badEvaluator","duplicateCriteria","badObjectiveIds"]{
 var value=mutatedNodes(payload(0,0..<3)){nodes in
  if mutation=="missing"{nodes.removeLast()}
  if mutation=="extra"{nodes[0]["extra"]="SENSITIVE_EXTRA"}
  if mutation=="order"{nodes.swapAt(0,1)}
  if mutation=="identity"{nodes[0]["ref"]="L512"}
  if mutation=="title"{nodes[0]["title"]="Different topic"}
  if mutation=="hostID"{nodes[0]["id"]="node_1_1"}
  if mutation=="objectiveID"{nodes[0]["objectives"]=[["id":"chosen_id","description":"Explain"]]}
  if mutation=="future"{nodes[0]["prerequisites"]=["L5"]}
  if mutation=="unknown"{nodes[0]["prerequisites"]=["L999"]}
  if mutation=="duplicateDependency"{nodes[1]["prerequisites"]=["L1","L1"]}
  if mutation=="self"{nodes[0]["prerequisites"]=["L1"]}
  if mutation=="missingActivities"{nodes[0].removeValue(forKey:"activities")}
  if mutation=="emptyActivity"{nodes[0]["activities"]=[" "]}
  if mutation=="noObjectives"{nodes[0]["objectives"]=[]}
  if mutation=="timeZero"{nodes[0]["estimatedMinutes"]=0}
  if mutation=="timeFraction"{nodes[0]["estimatedMinutes"]=1.5}
  if mutation=="timeBool"{nodes[0]["estimatedMinutes"]=true}
  if mutation=="missingAssessment"{nodes[0].removeValue(forKey:"assessment")}
  if mutation=="badAssessment"{nodes[0]["assessment"]=["task":"Explain","passCriteria":["All cases explained"],"mode":"qualitative","evaluatorPrompt":NSNull()]}
  if mutation=="badEvaluator"{nodes[0]["assessment"]=["task":"Explain","passCriteria":["All cases explained"],"mode":"qualitative","evaluatorPrompt":String(repeating:"x",count:4001)]}
  if mutation=="duplicateCriteria"{nodes[0]["assessment"]=["task":"Explain","passCriteria":["All cases explained","All cases explained"],"mode":"quantitative","evaluatorPrompt":NSNull()]}
  if mutation=="badObjectiveIds"{nodes[0]["assessment"]=["task":"Explain","passCriteria":["All cases explained"],"mode":"quantitative","evaluatorPrompt":NSNull(),"objectiveIds":["chosen_id"]]}
 }
 if mutation=="extra"{value["unexpected"]=true}
 rejected{_ = try PlanningGeneration.chapter(value,plan:plan,index:0,range:0..<3)}
}
let quantitative=mutatedNodes(payload(0,0..<1)){nodes in nodes[0]["assessment"]=["task":"Trace two named examples","passCriteria":["The dimensions match each operation"],"mode":"quantitative","evaluatorPrompt":NSNull()]}
let quantitativeNode=(try PlanningGeneration.chapter(quantitative,plan:plan,index:0,range:0..<1)["nodes"] as! [[String:Any]])[0],qa=quantitativeNode["assessment"] as! [String:Any]
check(qa["evaluatorPrompt"]==nil && qa["objectiveIds"] as! [String]==["node_1_1_o1","node_1_1_o2"])
let qualitative=mutatedNodes(payload(0,3..<4)){nodes in nodes[0]["assessment"]=["task":"Explain gradient correction","passCriteria":["Identify the cause and justify the correction"],"mode":"qualitative","evaluatorPrompt":"Inspect the attempted gradient and correction. Require the cause and corrected operation; request missing evidence."]}
let batch2=try PlanningGeneration.chapter(qualitative,plan:plan,index:0,range:3..<4)
var completeFirst=batch1;completeFirst["nodes"]=(batch1["nodes"] as! [[String:Any]])+(batch2["nodes"] as! [[String:Any]])
_ = try PlanningGeneration.chapterPrompt(context:context,plan:plan,index:1,completed:[completeFirst])
let secondPayload=mutatedNodes(payload(1,0..<1)){nodes in nodes[0]["prerequisites"]=["L1","L3","L4"]}
let completeSecond=try PlanningGeneration.chapter(secondPayload,plan:plan,index:1)
check((completeSecond["nodes"] as! [[String:Any]])[0]["prerequisites"] as! [String]==["node_1_1","node_1_3","node_1_4"],"earlier aliases resolved relative to batch instead of global outline")
for dependency in ["L5","L6","node_1_1","L01"]{let bad=mutatedNodes(payload(1,0..<1)){nodes in nodes[0]["prerequisites"]=[dependency]};rejected{_ = try PlanningGeneration.chapter(bad,plan:plan,index:1)}}
var parallelOutline=outline;parallelOutline["chapters"]=[second,first,second]
let parallelPlan=try PlanningGeneration.plan(envelope(parallelOutline),locale:"zh-CN"),parallelPrefix=try PlanningGeneration.chapter(payload(1,0..<3,for:parallelPlan),plan:parallelPlan,index:1,range:0..<3)
let parallelNext=try promptData(PlanningGeneration.chapterPrompt(context:context,plan:parallelPlan,index:1,completed:[parallelPrefix],range:3..<4,plannedPrerequisites:true))
check((parallelNext["availablePrerequisites"] as! [[String:Any]]).map{$0["ref"] as! String}==["L1","L2","L3","L4"],"parallel context lost global chapter order")
check(!(parallelNext["availablePrerequisites"] as! [[String:Any]]).contains{$0["ref"] as? String=="L6"},"future chapter exposed as prerequisite")
rejected{_ = try PlanningGeneration.chapterPrompt(context:context,plan:parallelPlan,index:1,completed:[["id":"ch_1","nodes":parallelPrefix["nodes"]!]],range:3..<4,plannedPrerequisites:true)}
rejected{_ = try plan.completeRoute([completeSecond,completeFirst])}
for mutation in ["missingNode","wrongObjectiveID","noActivities","futureDependency","missingChapterGoal"]{
 var chapters=[completeFirst,completeSecond],nodes=chapters[0]["nodes"] as! [[String:Any]]
 if mutation=="missingNode"{nodes.removeLast()}
 if mutation=="wrongObjectiveID"{nodes[0]["objectives"]=[["id":"model_owned","description":"Explain the operation"]]}
 if mutation=="noActivities"{nodes[0].removeValue(forKey:"activities")}
 if mutation=="futureDependency"{nodes[0]["prerequisites"]=["node_2_1"]}
 if mutation=="missingChapterGoal"{chapters[0].removeValue(forKey:"stageGoal")}
 chapters[0]["nodes"]=nodes;rejected{_ = try plan.completeRoute(chapters)}
}
let final=try plan.completeRoute([completeFirst,completeSecond])
check(final["locale"] as? String=="zh-CN" && final["sourceLanguage"] as? String=="zh-CN" && final["revision"] as? Int==1)
check((final["chapters"] as! [[String:Any]])[0]["stageGoal"] as? String==first["stageGoal"] as? String)
try JSONSerialization.data(withJSONObject:final).write(to:output)
print("PASS unified envelopes, host IDs, global task aliases, strict batches, outcomes and approved-only prompt data")
`);
  const compile=spawnSync('/usr/bin/swiftc',['-module-cache-path','tmp/cache/swift','apps/macos/RuntimeDirectory.swift','apps/macos/AgentManager.swift','apps/macos/CodeBuddyAdapter.swift','apps/macos/PlanningAgent.swift','apps/macos/PlanningPromptPackResources.swift','apps/macos/PlanningPromptPack.swift','apps/macos/PlanningGeneration.swift',source,'-o',binary],{encoding:'utf8',timeout:150_000});
  await writeFile(join(dir,'compile.log'),compile.stdout+compile.stderr);
  assert.equal(compile.status,0,compile.stderr);
  const output=join(dir,'route.json'),run=spawnSync(binary,[output],{encoding:'utf8',timeout:20_000});
  await writeFile(join(dir,'run.log'),run.stdout+run.stderr);
  assert.equal(run.status,0,run.stderr);assert.match(run.stdout,/PASS unified envelopes/);
  const route=JSON.parse(await readFile(output,'utf8'));assert.equal(validateRoute(route),route);assert.equal(route.chapters.length,2);assert.equal(route.chapters[0].nodes.length,4);assert.equal(route.chapters[1].nodes.length,1);
  for(const chapter of route.chapters)for(const node of chapter.nodes){assert.equal(Object.hasOwn(node,'ref'),false);assert.ok(node.activities.length);for(const objective of node.objectives)assert.match(objective.id,new RegExp(`^${node.id}_o[1-9]`));}
  for(const mutation of ['missingObjective','qualitativeWithoutEvaluator','wrongTime','unknownDependency','futureDependency']){
    const invalid=structuredClone(route),node=invalid.chapters[0].nodes[0];
    if(mutation==='missingObjective')delete node.objectives;
    if(mutation==='wrongTime')node.estimatedMinutes=0;
    if(mutation==='qualitativeWithoutEvaluator')node.assessment={task:'Explain',passCriteria:['All stated cases explained'],objectiveIds:[node.objectives[0].id],mode:'qualitative'};
    if(mutation==='unknownDependency')invalid.chapters[1].nodes[0].prerequisites=['node_unknown'];
    if(mutation==='futureDependency'){node.prerequisites=[invalid.chapters[1].nodes[0].id];invalid.chapters[1].nodes[0].prerequisites=[node.id];}
    assert.throws(()=>validateRoute(invalid),/ROUTE_INVALID/);
  }
});
