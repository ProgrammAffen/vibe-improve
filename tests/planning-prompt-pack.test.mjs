import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {loadPromptPack,assembleTask,renderSwift,matchesSchema,assertSchemaVocabulary} from '../scripts/build-planning-prompts.mjs';

const tasks=['interview','outline','lessons','review','consistency'];
const clone=value=>structuredClone(value);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);

// Check the source examples against their actual task schema, including the
// conditional envelope rules. No network, provider CLI or user library is used.
function valid(value,schema,root=schema){
  if(schema===true)return true;
  if(schema===false)return false;
  if(schema.$ref){
    assert.match(schema.$ref,/^#\/\$defs\//);
    const target=root.$defs[schema.$ref.slice('#/$defs/'.length)];
    assert.ok(target,`unresolved schema reference ${schema.$ref}`);
    if(!valid(value,target,root))return false;
  }
  if(schema.anyOf&&!schema.anyOf.some(part=>valid(value,part,root)))return false;
  if(schema.allOf&&!schema.allOf.every(part=>valid(value,part,root)))return false;
  if(schema.if&&valid(value,schema.if,root)&&schema.then&&!valid(value,schema.then,root))return false;
  if(schema.enum&&!schema.enum.some(item=>JSON.stringify(item)===JSON.stringify(value)))return false;
  if(Object.hasOwn(schema,'const')&&JSON.stringify(schema.const)!==JSON.stringify(value))return false;
  if(schema.type){
    const isType=type=>type==='null'?value===null:type==='array'?Array.isArray(value):type==='object'?object(value):type==='integer'?Number.isInteger(value):type==='number'?typeof value==='number'&&Number.isFinite(value):typeof value===type;
    if(!(Array.isArray(schema.type)?schema.type:[schema.type]).some(isType))return false;
  }
  if(typeof value==='string'){
    const length=Array.from(value).length;
    if(schema.minLength!==undefined&&length<schema.minLength)return false;
    if(schema.maxLength!==undefined&&length>schema.maxLength)return false;
    if(schema.pattern&&!new RegExp(schema.pattern).test(value))return false;
  }
  if(typeof value==='number'){
    if(schema.minimum!==undefined&&value<schema.minimum)return false;
    if(schema.maximum!==undefined&&value>schema.maximum)return false;
  }
  if(Array.isArray(value)){
    if(schema.minItems!==undefined&&value.length<schema.minItems)return false;
    if(schema.maxItems!==undefined&&value.length>schema.maxItems)return false;
    if(schema.uniqueItems&&new Set(value.map(item=>JSON.stringify(item))).size!==value.length)return false;
    if(schema.items&&!value.every(item=>valid(item,schema.items,root)))return false;
  }
  if(object(value)){
    if(schema.required?.some(key=>!Object.hasOwn(value,key)))return false;
    if(schema.propertyNames&&!Object.keys(value).every(key=>valid(key,schema.propertyNames,root)))return false;
    for(const [key,item] of Object.entries(value)){
      if(schema.properties?.[key]){if(!valid(item,schema.properties[key],root))return false}
      else if(schema.additionalProperties===false)return false;
      else if(object(schema.additionalProperties)&&!valid(item,schema.additionalProperties,root))return false;
    }
  }
  return true;
}

function reachableDefinitions(schema){
  const found=new Set(),queue=[schema.$ref];
  while(queue.length){
    const ref=queue.pop();assert.match(ref,/^#\/\$defs\//);
    const name=ref.slice('#/$defs/'.length);
    if(found.has(name))continue;
    found.add(name);assert.ok(schema.$defs[name],`missing ${name}`);
    const visit=value=>{
      if(Array.isArray(value))value.forEach(visit);
      else if(object(value)){if(value.$ref)queue.push(value.$ref);Object.values(value).forEach(visit)}
    };
    visit(schema.$defs[name]);
  }
  return [...found].sort();
}

test('one canonical prompt pack supplies isolated task schemas, valid examples and repair rules',async()=>{
  const pack=await loadPromptPack();
  assert.ok(pack.manifest.version);
  assert.ok(pack.examples.length>=8);
  for(const task of tasks){
    const assembled=assembleTask(pack,task),examples=pack.examples.filter(example=>example.task===task);
    assert.ok(examples.length,`missing ${task} examples`);
    assert.deepEqual(reachableDefinitions(assembled.schema),Object.keys(assembled.schema.$defs).sort(),`${task} includes unreachable definitions`);
    assert.match(assembled.system,new RegExp(`TASK: ${task}`));
    assert.match(assembled.system,/OUTPUT_SCHEMA:/);
    for(const other of tasks.filter(other=>other!==task))assert.ok(!assembled.system.includes(`TASK: ${other}`),`${task} contains another task's instructions`);
    if(task==='interview'){
      assert.ok(!Object.hasOwn(assembled.schema.$defs,'outlineResult'));
      assert.ok(!Object.hasOwn(assembled.schema.$defs,'lesson'));
    }
    for(const example of examples){
      assert.equal(valid(example.response,assembled.schema),true,example.name);
      if(example.task==='interview')assert.ok(assembled.system.includes(example.response.reply));
    }
    const repaired=assembleTask(pack,task,{repair:true});
    assert.match(repaired.system,/MODE: repair/);
    assert.ok(!assembled.system.includes('MODE: repair'));
    assert.deepEqual(repaired.schema,assembled.schema);
    const good=examples.find(example=>example.response.status==='ok').response;
    for(const mutation of [value=>{value.extra=true},value=>{value.result=null},value=>{value.missing=['unexpected']},value=>{value.status='success'},value=>{value.reply=3},value=>{value.missing={}}]){
      const changed=clone(good);mutation(changed);assert.equal(valid(changed,assembled.schema),false,`${task} invalid envelope accepted`);
    }
  }
  const edit=assembleTask(pack,'edit');
  assert.match(edit.system,/TASK: edit/);
  assert.equal(valid({reply:'This chapter teaches the named concepts.',route:null},edit.schema),true);
  assert.equal(valid({reply:'A proposed rename.',route:null,extra:true},edit.schema),false);
  for(const name of ['codex','claude','codebuddy','deepseek','glm','qoder','openclaw','hermes']){
    for(const task of [...tasks,'edit'])assert.ok(!assembleTask(pack,task).system.toLowerCase().includes(name),`model-specific rule ${name}`);
  }
});

test('checked-in Swift resources match deterministic generation',async()=>{
  const pack=await loadPromptPack(),path=resolve('apps/macos/PlanningPromptPackResources.swift');
  assert.equal(await readFile(path,'utf8'),renderSwift(pack));
  assert.equal(renderSwift(await loadPromptPack()),renderSwift(pack));
  const check=spawnSync(process.execPath,['scripts/build-planning-prompts.mjs','--check'],{encoding:'utf8',timeout:30_000});
  assert.equal(check.status,0,check.stderr||check.stdout);
  const runtime=await readFile(resolve('apps/macos/PlanningPromptPack.swift'),'utf8');
  assert.doesNotMatch(runtime,/String\(contentsOf:|FileManager|currentDirectoryPath|tmp\/review/);
});

test('generation rejects schema rules unsupported by the native validator and honors ref siblings',async()=>{
  const pack=await loadPromptPack();
  assert.doesNotThrow(()=>assertSchemaVocabulary(pack.schema));
  for(const mutation of [
    value=>{value.maxProperties=4},
    value=>{value.contains={type:'string'}},
    value=>{value.properties.summary={type:'number'}},
    value=>{value.properties.summary={$ref:'https://example.invalid/external.schema.json#/$defs/title'}},
    value=>{value.properties.summary={$ref:'#/$defs/notDefined'}}
  ]){
    const changed=clone(pack);mutation(changed.schema.$defs.interviewResult);
    assert.throws(()=>assembleTask(changed,'interview'));
    assert.throws(()=>renderSwift(changed));
  }
  const otherTask=clone(pack);otherTask.schema.$defs.lessonsResult.maxProperties=2;
  assert.doesNotThrow(()=>assembleTask(otherTask,'interview'));
  assert.throws(()=>assembleTask(otherTask,'lessons'));
  assert.throws(()=>renderSwift(otherTask));
  const unreachable=clone(pack);unreachable.schema.$defs.unusedFutureSchema={type:'object',contains:{type:'string'}};
  assert.throws(()=>assertSchemaVocabulary(unreachable.schema));
  assert.doesNotThrow(()=>assembleTask(unreachable,'interview'));
  assert.doesNotThrow(()=>renderSwift(unreachable));
  const referenced={$ref:'#/$defs/base',maxLength:3,$defs:{base:{type:'string',minLength:2}}};
  assert.doesNotThrow(()=>assertSchemaVocabulary(referenced));
  assert.equal(matchesSchema('abc',referenced,referenced),true);
  assert.equal(matchesSchema('abcd',referenced,referenced),false);
  assert.equal(matchesSchema('a',referenced,referenced),false);
  for(const unsupported of [
    {type:'number'},
    {type:'string',unknownValidationKeyword:1},
    {type:'object',maxProperties:1},
    {type:'object',additionalProperties:{type:'string'}},
    {type:'array',contains:{type:'string'}},
    {type:['string','null']},
    {type:'string',minLength:'3'},
    {type:'string',pattern:'['},
    {$ref:'#/$defs/missing',$defs:{}},
    {$ref:'https://example.invalid/schema.json'}
  ]){
    assert.throws(()=>assertSchemaVocabulary(unsupported));
    assert.throws(()=>matchesSchema({},unsupported,unsupported));
  }
});

function canonicalParityCases(pack){
  const cases=pack.examples.map(example=>({name:example.name,task:example.task,response:clone(example.response),valid:true}));
  const add=(name,task,mutate,expected=false)=>{
    const example=pack.examples.find(example=>example.task===task&&(task==='edit'||example.response.status==='ok'));
    const response=clone(example.response);mutate(response);cases.push({name,task,response,valid:expected});
  };
  for(const task of [...tasks,'edit']){
    add(task+'-unknown-root-field',task,value=>{value.extra=true});
    add(task+'-numeric-reply',task,value=>{value.reply=1});
    add(task+'-empty-reply',task,value=>{value.reply=''});
    if(task==='edit'){
      add('edit-array-route',task,value=>{value.route=[]});
      add('edit-missing-route',task,value=>{delete value.route});
      add('edit-ordinary-null-route',task,value=>{value.route=null},true);
      continue;
    }
    add(task+'-unknown-status',task,value=>{value.status='success'});
    add(task+'-numeric-status',task,value=>{value.status=1});
    add(task+'-object-missing',task,value=>{value.missing={}});
    add(task+'-mixed-missing',task,value=>{value.missing=['gap',1]});
    add(task+'-array-result',task,value=>{value.result=[]});
    add(task+'-null-ok-result',task,value=>{value.result=null});
    add(task+'-extra-result-field',task,value=>{value.result.extra=true});
    add(task+'-ok-with-gap',task,value=>{value.missing=['gap']});
    for(const status of ['needs_input','cannot_complete']){
      const outcome={status,reply:'Choose a smaller scope.',result:null,missing:['scope']};
      cases.push({name:task+'-'+status,task,response:outcome,valid:true});
      cases.push({name:task+'-'+status+'-with-result',task,response:{...outcome,result:{}},valid:false});
      cases.push({name:task+'-'+status+'-without-gap',task,response:{...outcome,missing:[]},valid:status==='cannot_complete'});
    }
  }
  add('interview-numeric-complete','interview',value=>{value.result.complete=1});
  add('interview-field-of-another-question','interview',value=>{value.result.fields={weekly:'an hour'}});
  add('interview-field-value-boolean','interview',value=>{value.result.fields={topic:true}});
  add('interview-complete-with-gap','interview',value=>{value.result.unresolved=['Choose a goal.']});
  add('interview-assistant-user-ref','interview',value=>{value.result.evidence[0].messageRef='A1'});
  add('interview-user-proposal-ref','interview',value=>{value.result.evidence[0].proposalRef='U1'});
  add('interview-missing-nullable-field','interview',value=>{delete value.result.evidence[0].proposalRef});
  for(const minutes of [true,'45',0,1441,1.5])add('lessons-minutes-'+JSON.stringify(minutes),'lessons',value=>{value.result.nodes[0].estimatedMinutes=minutes});
  add('lessons-valid-integer-boundary','lessons',value=>{value.result.nodes[0].estimatedMinutes=1440},true);
  add('lessons-unknown-node-field','lessons',value=>{value.result.nodes[0].id='host_identifier'});
  add('lessons-mixed-objectives','lessons',value=>{value.result.nodes[0].objectives=['Name the operation.',1]});
  add('lessons-duplicate-prerequisites','lessons',value=>{value.result.nodes[0].prerequisites=['L1','L1']});
  add('lessons-empty-activities','lessons',value=>{value.result.nodes[0].activities=[]});
  add('review-numeric-ready','review',value=>{value.result.ready=1});
  add('review-numeric-blocking','review',value=>{value.result.issues[0].blocking=1});
  add('review-unknown-issue-code','review',value=>{value.result.issues[0].code='style'});
  add('review-malformed-target-ref','review',value=>{value.result.issues[0].targetRefs=['host_identifier']});
  return cases;
}

test('canonical response mutations have explicit JavaScript schema outcomes',async()=>{
  const pack=await loadPromptPack();
  for(const fixture of canonicalParityCases(pack)){
    const {schema}=assembleTask(pack,fixture.task);
    assert.equal(matchesSchema(fixture.response,schema,schema),fixture.valid,fixture.name+' JS schema expectation');
  }
});

test('native prompt rendering, strict envelopes and interview reference mapping',{skip:process.platform!=='darwin',timeout:180_000},async()=>{
  const root=resolve('tmp/checks/planning-prompt-pack');await mkdir(root,{recursive:true});const dir=await mkdtemp(join(root,'native-'));
  const source=join(dir,'main.swift'),binary=join(dir,'verify'),fixtures=join(dir,'examples.json'),parityPath=join(dir,'schema-parity.json');
  const pack=await loadPromptPack(),parity=canonicalParityCases(pack);
  for(const fixture of parity){
    const {schema}=assembleTask(pack,fixture.task);
    assert.equal(matchesSchema(fixture.response,schema,schema),fixture.valid,fixture.name+' JS schema expectation');
  }
  await writeFile(fixtures,JSON.stringify(pack.examples));await writeFile(parityPath,JSON.stringify(parity));
  await writeFile(source,String.raw`import Foundation
func check(_ value:Bool,_ message:String="assertion failed"){if !value{fatalError(message)}}
func rejected(_ action:()throws->Void){do{try action();fatalError("invalid prompt result accepted")}catch let e as PlanningPromptPackError{check([.invalid,.evidence,.tooLarge].contains(e))}catch{fatalError("unexpected error: \(error)")}}
func json(_ value:Any)throws->Data{try JSONSerialization.data(withJSONObject:value,options:.sortedKeys)}
func copied(_ value:[String:Any])throws->[String:Any]{try JSONSerialization.jsonObject(with:json(value)) as! [String:Any]}
let examples=try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[1]))) as! [[String:Any]]
let parity=try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[2]))) as! [[String:Any]]
for fixture in parity {
 let task=fixture["task"] as! String,response=fixture["response"] as! [String:Any],expected=fixture["valid"] as! Bool
 var accepted=false
 do{_ = try PlanningPromptPack.unwrap(response,task:task);accepted=true}
 catch is PlanningTaskOutcome{accepted=true}
 catch is PlanningPromptPackError{}
 catch{fatalError("unexpected parity error")}
 check(accepted==expected,(fixture["name"] as! String)+" JS/Swift schema mismatch")
}
let marker="\nCONTEXT_JSON_DATA:\n"
for example in examples{
 guard let task=example["task"] as? String,["interview","outline","lessons","review","consistency"].contains(task) else{continue}
 let response=example["response"] as! [String:Any]
 if response["status"] as? String=="ok"{
  check(try json(PlanningPromptPack.unwrap(response,task:task))==json(response["result"]!))
 }else{
  do{_ = try PlanningPromptPack.unwrap(response,task:task);fatalError("non-success accepted")}catch let e as PlanningTaskOutcome{
   check(e.code=="PLANNING_NEEDS_INPUT"||e.code=="PLANNING_CANNOT_COMPLETE")
   check(e.userReply==response["reply"] as? String)
   check(e.missing==response["missing"] as? [String])
   check(String(describing:e)==e.code && String(reflecting:e)==e.code)
  }
 }
 let prompt=try PlanningPromptPack.make(task:task,data:["locale":"zh-CN","probe":"SYNTHETIC_CONTEXT_ONLY"])
 check(prompt.hasPrefix(PlanningPromptPack.policy))
 let split=prompt.range(of:marker)!,instructions=String(prompt[..<split.lowerBound])
 check(!instructions.contains("SYNTHETIC_CONTEXT_ONLY"))
 let context=try JSONSerialization.jsonObject(with:Data(prompt[split.upperBound...].utf8)) as! [String:Any]
 check(context["probe"] as? String=="SYNTHETIC_CONTEXT_ONLY")
 check(instructions.contains("TASK: "+task))
 for other in ["interview","outline","lessons","review","consistency"].filter({$0 != task}){check(!instructions.contains("TASK: "+other))}
 let repaired=try PlanningPromptPack.make(task:task,data:["locale":"zh-CN"],repair:true)
 check(repaired.contains("MODE: repair"))
}
let outline=examples.first{$0["name"] as? String=="outline-complete"}!["response"] as! [String:Any]
// JSON Schema counts Unicode scalars; the client also bounds UTF-16 and UTF-8.
for task in ["interview","outline","lessons","review","edit"] {
 var response=examples.first{example in example["task"] as? String==task && (task=="edit" || (example["response"] as? [String:Any])?["status"] as? String=="ok")}!["response"] as! [String:Any]
 for boundary in [String(repeating:"😀",count:4000),String(repeating:"界",count:8000)] {
  response["reply"]=boundary;_ = try PlanningPromptPack.unwrap(response,task:task)
 }
 for oversized in [String(repeating:"😀",count:4001),String(repeating:"界",count:8001)] {
  response["reply"]=oversized;rejected{_ = try PlanningPromptPack.unwrap(response,task:task)}
 }
 if task != "edit" {
  for status in ["needs_input","cannot_complete"] {
   let invalid:[String:Any]=["status":status,"reply":String(repeating:"😀",count:4001),"result":NSNull(),"missing":["scope"]]
   rejected{_ = try PlanningPromptPack.unwrap(invalid,task:task)}
  }
 }
}
for mutation in ["extra","replyNumber","statusNumber","statusUnknown","missingObject","missingMixed","resultArray","resultExtra","okWithoutResult","okMissing"]{
 var value=try copied(outline)
 if mutation=="extra"{value["unexpected"]="SENSITIVE_NOT_LOGGED"}
 if mutation=="replyNumber"{value["reply"]=1}
 if mutation=="statusNumber"{value["status"]=1}
 if mutation=="statusUnknown"{value["status"]="success"}
 if mutation=="missingObject"{value["missing"]=[String:String]()}
 if mutation=="missingMixed"{value["missing"]=["gap",1] as [Any]}
 if mutation=="resultArray"{value["result"]=[] as [Any]}
 if mutation=="resultExtra"{var result=value["result"] as! [String:Any];result["extra"]=true;value["result"]=result}
 if mutation=="okWithoutResult"{value["result"]=NSNull()}
 if mutation=="okMissing"{value["missing"]=["unresolved"]}
 rejected{_ = try PlanningPromptPack.unwrap(value,task:"outline")}
}
for status in ["needs_input","cannot_complete"]{
 let response:[String:Any]=["status":status,"reply":"Please choose a smaller scope.","result":NSNull(),"missing":["scope"]]
 do{_ = try PlanningPromptPack.unwrap(response,task:"outline");fatalError("business outcome accepted")}catch let e as PlanningTaskOutcome{check(e.code==(status=="needs_input" ? "PLANNING_NEEDS_INPUT":"PLANNING_CANNOT_COMPLETE"));check(e.userReply=="Please choose a smaller scope.")}
 var invalid=response;invalid["result"]=[String:Any]();rejected{_ = try PlanningPromptPack.unwrap(invalid,task:"outline")}
 if status=="needs_input"{invalid=response;invalid["missing"]=[] as [String];rejected{_ = try PlanningPromptPack.unwrap(invalid,task:"outline")}}
}
var interview=examples.first{$0["name"] as? String=="interview-adoption"}!["response"] as! [String:Any]
for mutation in ["numericBoolean","extraField","wrongQuestionField","missingEvidenceKey","evidenceObject","nonStringField","completeWithUnresolved"]{
 var response=try copied(interview),result=response["result"] as! [String:Any]
 if mutation=="numericBoolean"{result["complete"]=1}
 if mutation=="extraField"{result["extra"]=true}
 if mutation=="wrongQuestionField"{result["fields"]=["weekly":"an hour"]}
 if mutation=="missingEvidenceKey"{var evidence=result["evidence"] as! [[String:Any]];evidence[0].removeValue(forKey:"proposalRef");result["evidence"]=evidence}
 if mutation=="evidenceObject"{result["evidence"]=[String:Any]()}
 if mutation=="nonStringField"{result["fields"]=["topic":1]}
 if mutation=="completeWithUnresolved"{result["unresolved"]=["what outcome?"]}
 response["result"]=result;rejected{_ = try PlanningPromptPack.unwrap(response,task:"interview")}
}
let lessons=examples.first{$0["name"] as? String=="lessons-complete"}!["response"] as! [String:Any]
for mutation in ["booleanMinutes","mixedObjectives","missingActivities","duplicatePrerequisites","unknownNodeKey"]{
 var response=try copied(lessons),result=response["result"] as! [String:Any],nodes=result["nodes"] as! [[String:Any]]
 if mutation=="booleanMinutes"{nodes[0]["estimatedMinutes"]=true}
 if mutation=="mixedObjectives"{nodes[0]["objectives"]=["specific objective",1] as [Any]}
 if mutation=="missingActivities"{nodes[0]["activities"]=[] as [String]}
 if mutation=="duplicatePrerequisites"{nodes[0]["prerequisites"]=["L2","L2"]}
 if mutation=="unknownNodeKey"{nodes[0]["id"]="persistent_id_from_model"}
 result["nodes"]=nodes;response["result"]=result;rejected{_ = try PlanningPromptPack.unwrap(response,task:"lessons")}
}
let messages:[[String:Any]]=[
 ["id":"private_old_user","role":"user","questionId":"goal","text":"SENSITIVE_OLD_ROUND"],
 ["id":"private_old_assistant","role":"assistant","questionId":"goal","text":"SENSITIVE_OLD_PROPOSAL"],
 ["id":"private_other_user","role":"user","questionId":"purpose","text":"SENSITIVE_OTHER_QUESTION"],
 ["id":"private_other_assistant","role":"assistant","questionId":"purpose","text":"SENSITIVE_OTHER_PROPOSAL"],
 ["id":"private_topic","role":"user","questionId":"goal","text":"我想练习产品访谈。"],
 ["id":"private_suggestion","role":"assistant","questionId":"goal","text":"可以把目标定为澄清含糊需求并指出约束，你愿意吗？"],
 ["id":"private_assent","role":"user","questionId":"goal","text":"可以，就按刚才那个。"],
 ["id":"private_later_suggestion","role":"assistant","questionId":"goal","text":"这是后续建议。"]]
let context:[String:Any]=["locale":"zh-CN","currentQuestion":"goal","projectId":"PRIVATE_PROJECT_ID","questions":[
 ["id":"goal","status":"current","summary":"UNACCEPTED_DRAFT","fields":["topic":"existing fact"],"conversationFrom":4],
 ["id":"purpose","status":"complete","summary":"Accepted meeting context","fields":["context":"team meetings"]],
 ["id":"baseline","status":"awaiting-confirmation","summary":"UNACCEPTED_BASELINE","fields":["experience":"UNACCEPTED_EXPERIENCE"]]],"messages":messages,"resources":"Named synthetic workbook","routeDraft":["title":"SENSITIVE_OLD_ROUTE"]]
let input=try PlanningPromptPack.interviewInput(context),wireMessages=input["messages"] as! [[String:Any]]
check(wireMessages.map{$0["ref"] as! String}==["U1","A1","U2","A2"])
check(wireMessages.map{$0["role"] as! String}==["user","assistant","user","assistant"])
check(wireMessages.allSatisfy{$0["id"]==nil && $0["questionId"]==nil})
let serialized=String(decoding:try json(input),as:UTF8.self)
for hidden in ["private_","PRIVATE_PROJECT_ID","SENSITIVE_OLD_","SENSITIVE_OTHER_","UNACCEPTED_"]{check(!serialized.contains(hidden),"private or unaccepted state entered prompt")}
let accepted=input["acceptedAnswers"] as! [String:Any]
check(Set(accepted.keys)==["purpose"])
check((input["currentFields"] as? [String:String])?["topic"]=="existing fact")
check(input["resources"] as? String=="Named synthetic workbook")
check(input["routeDraft"]==nil && input["questions"]==nil)
var result=interview["result"] as! [String:Any]
result["fields"]=["topic":"产品访谈","outcome":"澄清含糊需求并指出约束"]
result["evidence"]=[["field":"topic","messageRef":"U1","proposalRef":NSNull(),"quote":"用户给出方向"],["field":"outcome","messageRef":"U2","proposalRef":"A1","quote":"用户明确采用建议"]]
interview["result"]=result
let mapped=try PlanningPromptPack.interviewResult(interview,context:context),updates=mapped["updates"] as! [[String:Any]],evidence=updates[0]["evidence"] as! [[String:Any]]
check(mapped["reply"] as? String==interview["reply"] as? String)
check(mapped["summary"] as? String==result["summary"] as? String)
check(updates.count==1 && updates[0]["id"] as? String=="goal")
check(evidence[0]["messageId"] as? String=="private_topic" && evidence[0]["proposalMessageId"]==nil)
check(evidence[1]["messageId"] as? String=="private_assent" && evidence[1]["proposalMessageId"] as? String=="private_suggestion")
check((updates[0]["missing"] as? [String])?.isEmpty==true)
for mutation in ["unknownUser","assistantAsUser","userAsProposal","laterProposal","unknownProposal","oldRealId","otherQuestion","duplicateEvidence","orphanEvidence","missingEvidence"]{
 var response=try copied(interview),bad=response["result"] as! [String:Any],items=bad["evidence"] as! [[String:Any]]
 if mutation=="unknownUser"{items[0]["messageRef"]="U99"}
 if mutation=="assistantAsUser"{items[0]["messageRef"]="A1"}
 if mutation=="userAsProposal"{items[1]["proposalRef"]="U1"}
 if mutation=="laterProposal"{items[1]["proposalRef"]="A2"}
 if mutation=="unknownProposal"{items[1]["proposalRef"]="A99"}
 if mutation=="oldRealId"{items[0]["messageRef"]="private_old_user"}
 if mutation=="otherQuestion"{bad["questionId"]="purpose";bad["fields"]=["context":"meeting"];items=[["field":"context","messageRef":"U1","proposalRef":NSNull(),"quote":"wrong question"]]}
 if mutation=="duplicateEvidence"{items.append(items[0])}
 if mutation=="orphanEvidence"{items.append(["field":"outcome","messageRef":"U2","proposalRef":"A1","quote":"duplicate field"])}
 if mutation=="missingEvidence"{items.removeFirst()}
 bad["evidence"]=items;response["result"]=bad;rejected{_ = try PlanningPromptPack.interviewResult(response,context:context)}
}
// Adopted snapshots survive draft edits and targeted review; IDs/hashes stay host-only.
var snapshotContext=context,snapshotQuestions=context["questions"] as! [[String:Any]]
snapshotQuestions[0]["fields"]=["topic":"UNADOPTED_NEW_DRAFT"]
snapshotQuestions[0]["summary"]="UNADOPTED_NEW_SUMMARY"
snapshotQuestions[0]["acceptedSnapshot"]=["revision":3,"summary":"Adopted original goal","fields":["topic":"original topic","outcome":"original outcome"],"evidence":["PRIVATE_SNAPSHOT_EVIDENCE"]]
snapshotQuestions[1]["status"]="needs-review"
snapshotQuestions[1]["acceptedSnapshot"]=["revision":2,"summary":"Adopted meeting context","fields":["context":"team meetings"],"evidence":[]]
snapshotContext["questions"]=snapshotQuestions
snapshotContext["consistency"]=["anchorQuestionId":"goal","anchorRevision":3,"factsHash":"PRIVATE_FACT_HASH","epoch":9]
var legacyContext=context,legacyQuestions=context["questions"] as! [[String:Any]]
legacyQuestions[1]["summary"]="";legacyContext["questions"]=legacyQuestions
check((try PlanningPromptPack.acceptedAnswers(legacyContext)["purpose"] as! [String:Any])["summary"] as? String=="")
legacyQuestions[1]["acceptedSnapshot"]=["revision":0,"summary":"","fields":["context":"team meetings"],"evidence":[]]
legacyContext["questions"]=legacyQuestions;_ = try PlanningPromptPack.consistencyInput(legacyContext)
legacyQuestions[1]["acceptedSnapshot"]=["revision":1,"summary":"","fields":["context":"team meetings"],"evidence":[]]
legacyContext["questions"]=legacyQuestions;rejected{_ = try PlanningPromptPack.acceptedAnswers(legacyContext)}
let snapshotInput=try PlanningPromptPack.interviewInput(snapshotContext),snapshotAnswers=try PlanningPromptPack.acceptedAnswers(snapshotContext)
check(((snapshotAnswers["goal"] as! [String:Any])["fields"] as! [String:String])["topic"]=="original topic")
check((snapshotInput["acceptedAnswer"] as! [String:Any])["summary"] as? String=="Adopted original goal")
check((snapshotInput["currentFields"] as! [String:String])["topic"]=="UNADOPTED_NEW_DRAFT")
check(snapshotAnswers["purpose"] != nil && snapshotAnswers["baseline"]==nil)
let preflight=try PlanningPromptPack.consistencyInput(snapshotContext),preflightText=String(decoding:try json(preflight),as:UTF8.self)
check(preflight["anchorQuestionId"] as? String=="goal")
check(!preflightText.contains("UNADOPTED_") && !preflightText.contains("PRIVATE_") && !preflightText.contains("revision"))
let issue:[String:Any]=["questionId":"purpose","fields":["criteria"],"kind":"uncertain","reason":"The adopted context does not yet specify the success criteria for the new goal.","suggestion":NSNull()]
let assessment:[String:Any]=["status":"requires_review","issues":[issue]]
let consistencyEnvelope:[String:Any]=["status":"ok","reply":"Please review the success criteria.","result":assessment,"missing":[]]
let consistencyMapped=try PlanningPromptPack.consistencyResult(consistencyEnvelope,context:snapshotContext)
check((consistencyMapped["consistency"] as! [String:Any])["status"] as? String=="requires_review")
for mutation in ["unknownQuestion","wrongField","duplicateQuestion","suggestionOutsideIssue","emptyReview","nonemptyConsistent"] {
 var envelope=try copied(consistencyEnvelope),result=envelope["result"] as! [String:Any],bad=issue
 if mutation=="unknownQuestion"{bad["questionId"]="baseline";bad["fields"]=["experience"]}
 if mutation=="wrongField"{bad["fields"]=["weekly"]}
 if mutation=="suggestionOutsideIssue"{bad["suggestion"]=["summary":"Change context","fields":["context":"Different meeting"]]}
 result["issues"]=mutation=="duplicateQuestion" ? [bad,bad]:[bad]
 if mutation=="emptyReview"{result["issues"]=[] as [[String:Any]]}
 if mutation=="nonemptyConsistent"{result["status"]="consistent"}
 envelope["result"]=result;rejected{_ = try PlanningPromptPack.consistencyResult(envelope,context:snapshotContext)}
}
var interviewWithConsistency=interview,interviewCandidate=interview["result"] as! [String:Any]
interviewCandidate["consistency"]=assessment;interviewWithConsistency["result"]=interviewCandidate
check((try PlanningPromptPack.interviewResult(interviewWithConsistency,context:snapshotContext))["consistency"] is [String:Any])
let late:[String:Any]=["status":"needs_input","reply":"Review the criteria.","result":NSNull(),"missing":["criteria"],"consistency":assessment]
for task in ["interview","outline","lessons","review","consistency"] {
 do{_ = try PlanningPromptPack.unwrap(late,task:task);fatalError("late conflict treated as success")}catch let outcome as PlanningTaskOutcome{check(outcome.consistency?["status"] as? String=="requires_review")}
}

var duplicateContext=context,duplicateMessages=messages;duplicateMessages[6]["id"]="private_topic";duplicateContext["messages"]=duplicateMessages
rejected{_ = try PlanningPromptPack.interviewInput(duplicateContext)}
var invalidRound=context,questions=context["questions"] as! [[String:Any]];questions[0]["conversationFrom"]=messages.count+1;invalidRound["questions"]=questions
rejected{_ = try PlanningPromptPack.interviewInput(invalidRound)}
var numericRound=context;questions[0]["conversationFrom"]=true;numericRound["questions"]=questions
rejected{_ = try PlanningPromptPack.interviewInput(numericRound)}
var unsupported=context;unsupported["locale"]="unsupported";rejected{_ = try PlanningPromptPack.interviewInput(unsupported)}
rejected{_ = try PlanningPromptPack.make(task:"unknown",data:["locale":"zh-CN"])}
print("PASS canonical examples, isolated embedded prompts, strict envelopes and current-round reference mapping")
`);
  const compile=spawnSync('/usr/bin/swiftc',['-module-cache-path','tmp/cache/swift','apps/macos/PlanningPromptPack.swift','apps/macos/PlanningPromptPackResources.swift',source,'-o',binary],{encoding:'utf8',timeout:150_000});
  assert.equal(compile.status,0,compile.stderr);
  const run=spawnSync(binary,[fixtures,parityPath],{encoding:'utf8',timeout:20_000});
  assert.equal(run.status,0,run.stderr);assert.match(run.stdout,/PASS canonical examples/);
});
