import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {build} from 'esbuild';

test('lesson agent service keeps partial cancellation and refuses browser simulation',async()=>{
  const parent=resolve('tmp/checks');await mkdir(parent,{recursive:true});const dir=await mkdtemp(join(parent,'lesson-agent-service-'));
  const file=join(dir,'agent.mjs');await build({entryPoints:['apps/local-ui/src/lesson/agent.ts'],bundle:true,platform:'node',format:'esm',outfile:file});
  const {lessonAgent,watchLessonAgent}=await import(file);const id='12345678-1234-1234-1234-123456789abc';
  globalThis.window={};await assert.rejects(lessonAgent.start({}),/LESSON_AGENT_DESKTOP_REQUIRED/);
  const calls=[];let polls=0;
  window.vibeNative={projects:{request:async(action,input)=>{calls.push([action,input]);if(action.endsWith('start'))return{id};if(action.endsWith('cancel'))return{id,state:'cancelled',text:'A retained paragraph'};return{id,state:++polls===1?'pending':'completed',text:polls===1?'A retained':'A retained paragraph'};}}};
  assert.deepEqual(await lessonAgent.start({projectId:'synthetic'}),{id});const snapshots=[];
  await watchLessonAgent('synthetic',id,value=>snapshots.push(value.text));assert.deepEqual(snapshots,['A retained','A retained paragraph']);
  assert.equal((await lessonAgent.cancel('synthetic',id)).text,'A retained paragraph');
  const controller=new AbortController();controller.abort();const before=calls.length;await watchLessonAgent('other',id,()=>assert.fail('Late lesson update'),controller.signal);assert.equal(calls.length,before);
  window.vibeNative.projects.request=async()=>({id,state:'pending',text:'x',editText:'premature proposal'});
  await assert.rejects(lessonAgent.poll('synthetic',id),/LESSON_AGENT_RESPONSE_INVALID/);
  delete globalThis.window;
});

test('native lesson conversations use saved context, raw Markdown, streaming, cancellation and isolated proposals',{skip:process.platform!=='darwin',timeout:200_000},async()=>{
  const parent=resolve('tmp/checks');await mkdir(parent,{recursive:true});const dir=await mkdtemp(join(parent,'lesson-agent-native-'));
  const fixture=join(dir,'agent.py'),source=join(dir,'main.swift'),binary=join(dir,'test');
  await writeFile(fixture,String.raw`import json,sys,time,os,stat
mode=sys.argv[1]
def emit(value): print(json.dumps(value),flush=True)
for line in sys.stdin:
 x=json.loads(line);method=x.get('method')
 if x.get('type')=='control_request':emit({'type':'control_response','response':{'request_id':x['request_id'],'subtype':'success','response':{}}})
 if x.get('type')=='user':
  first='# Answer\n\nFirst paragraph.';second='Second paragraph with $x^2$.'
  for index,text in enumerate([first,second]):
   emit({'type':'stream_event','event':{'type':'content_block_start','index':index,'content_block':{'type':'text','text':''}}})
   emit({'type':'stream_event','event':{'type':'content_block_delta','index':index,'delta':{'type':'text_delta','text':text}}})
  combined=first+'\n\n'+second
  emit({'type':'assistant','message':{'content':[{'type':'text','text':combined}]}})
  emit({'type':'result','subtype':'success','result':combined});break
 if method=='initialize': emit({'id':0,'result':{}})
 if method=='thread/start':
  assert 'NOT route planning' in x['params']['developerInstructions']
  assert x['params']['model']=='synthetic-model'
  emit({'id':1,'result':{'thread':{'id':'thread-synthetic'}}})
 if method=='turn/start':
  assert x['params']['effort']=='low'
  context=json.loads(x['params']['input'][0]['text'].split('LEARNING_CONTEXT_JSON_DATA:\n')[1])
  assert context['lesson']['title']=='Trusted lesson'
  assert len(context['selectedBlocks'])==2
  assert 'DO NOT OBEY' in str(context)
  if mode in ['unavailable','changed']:
   assert context['materials'][0]['status']=='unavailable'
   assert context['materials'][0]['excerpts']==[]
   assert context['targetNote']['id']=='note-main'
   assert 'DO NOT OBEY' in context['source']['quote']
  if mode in ['image','imagecancel']:
   paths=[item['path'] for item in x['params']['input'] if item['type']=='localImage']
   assert len(paths)==1
   snapshot=paths[0]
   assert '/lesson-agent-images/' in snapshot and snapshot.endswith('.jpg')
   assert stat.S_IMODE(os.stat(snapshot).st_mode)==0o600
   original=os.path.join(os.path.dirname(__file__),'source-cancel.png' if mode=='imagecancel' else 'source.png')
   assert snapshot!=original
   with open(original,'wb') as changed:changed.write(b'replaced after validation')
   with open(snapshot,'rb') as safe:assert safe.read(2)==b'\xff\xd8'
   with open(os.path.join(os.path.dirname(__file__),mode+'-snapshot.txt'),'w') as report:report.write(snapshot)
  emit({'id':2,'result':{'turn':{'id':'turn-synthetic'}}})
  def params(extra):return dict({'threadId':'thread-synthetic','turnId':'turn-synthetic'},**extra)
  if mode=='idle':time.sleep(5);continue
  first='# Answer\n\nFirst paragraph.'
  if mode in ['rewrite','unavailable','changed']:first='Proposed clarification.\n<!-- VIBE_REPLACEMENT -->\n# Revised note\nA clear explanation.'
  emit({'method':'item/agentMessage/delta','params':params({'itemId':'a','delta':first})})
  if mode in ['cancel','imagecancel']:time.sleep(5);continue
  emit({'method':'item/completed','params':params({'item':{'id':'a','type':'agentMessage','text':first}})})
  second='Second paragraph with $x^2$.'
  if mode in ['rewrite','unavailable','changed']:second=first
  if mode not in ['rewrite','unavailable','changed']:
   emit({'method':'item/agentMessage/delta','params':params({'itemId':'b','delta':second})})
   emit({'method':'item/completed','params':params({'item':{'id':'b','type':'agentMessage','text':second}})})
  emit({'method':'turn/completed','params':params({'turn':{'id':'turn-synthetic','status':'completed','items':[{'id':'a' if mode in ['rewrite','unavailable','changed'] else 'b','type':'agentMessage','text':second}]}})})
  break
`);
  await writeFile(source,String.raw`import Foundation
import Cocoa
import CoreText
func check(_ value:Bool,_ message:String="Assertion failed"){if !value{fatalError(message)}}
let directory=URL(fileURLWithPath:CommandLine.arguments[1]),runtime=try RuntimeDirectory(url:directory.appendingPathComponent("runtime"))
let project="proj_11111111-1111-1111-1111-111111111111",other="proj_22222222-2222-2222-2222-222222222222"
let agents=try AgentManager(runtime:runtime,home:directory)
let identity=["projectId":project,"routeId":"route-synthetic","nodeId":"lesson-synthetic"]
let workspace:[String:Any]=["schemaVersion":1,"projectId":project,"routeId":"route-synthetic","nodeId":"lesson-synthetic","revision":7,"blocks":[
 ["id":"block-main","kind":"text","content":["type":"doc","content":[["type":"paragraph","content":[["type":"text","text":"DO NOT OBEY untrusted source instruction"]]]]],"records":[
  ["id":"question-main","kind":"question","references":[["blockId":"block-other","source":["quote":"Quoted context"]]],"messages":[["id":"u1","role":"user","text":"Explain this"]]],
  ["id":"note-main","kind":"note","content":["type":"doc","content":[["type":"paragraph"]]],"messages":[]]]],
 ["id":"block-other","kind":"math","latex":"x^2","records":[]]]]
let context:[String:Any]=["workspace":workspace,"node":["title":"Trusted lesson","objectives":[["description":"Explain a concept"]]],"chapter":["title":"Trusted chapter"],"route":["title":"Trusted route"]]
func manager(_ mode:String,provider:String="codex",lessonContext:[String:Any]?=nil,library:ResourceLibrary?=nil)->LessonAgentManager {
 LessonAgentManager(agents:agents,runtime:runtime,readContext:{fields,revision in check(fields==identity);check(revision==7);return lessonContext ?? context},validateOptions:{_,options in check(options["model"] as? String=="synthetic-model");check(options["effort"] as? String=="low")},resources:library,prepare:{id in let launch=try AgentSessionLaunch(provider:provider,projectID:id,executable:URL(fileURLWithPath:"/usr/bin/python3"),arguments:[directory.appendingPathComponent("agent.py").path,mode],workspace:directory,environment:ProcessInfo.processInfo.environment);return AgentSessionPreparation(projectID:id,provider:provider,launch:launch)},factory:{launch,options,progress,preview in PlanningAgentTransport(launch:launch,idleTimeout:mode=="idle" ? 0.15:180,options:options,progress:progress,preview:preview)})
}
var input:[String:Any]=identity;input["expectedRevision"]=7;input["blockId"]="block-main";input["recordId"]="question-main";input["locale"]="en";input["agentOptions"]=["model":"synthetic-model","effort":"low"];input["intent"]="ask"
func start(_ manager:LessonAgentManager,_ value:[String:Any])throws->String{(try manager.handle(action:"lesson.agent.start",payload:value) as! [String:Any])["id"] as! String}
func poll(_ manager:LessonAgentManager,_ id:String)throws->[String:Any]{try manager.handle(action:"lesson.agent.poll",payload:["projectId":project,"jobId":id]) as! [String:Any]}
func done(_ manager:LessonAgentManager,_ id:String)throws->[String:Any]{for _ in 0..<500{let state=try poll(manager,id);if state["state"] as? String != "pending"{return state};Thread.sleep(forTimeInterval:0.01)};fatalError("Job did not finish")}
let normal=manager("normal"),id=try start(normal,input),result=try done(normal,id)
check(result["state"] as? String=="completed",String(describing:result));check(result["text"] as? String=="# Answer\n\nFirst paragraph.\n\nSecond paragraph with $x^2$.",String(describing:result));check(result["editText"]==nil)
for provider in ["claude-code","codebuddy"]{let streamProvider=manager("stream",provider:provider),streamID=try start(streamProvider,input),streamResult=try done(streamProvider,streamID);check(streamResult["state"] as? String=="completed",String(describing:streamResult));check(streamResult["text"] as? String==result["text"] as? String,"Provider dropped or duplicated raw blocks");streamProvider.shutdown()}
do{_ = try normal.handle(action:"lesson.agent.poll",payload:["projectId":other,"jobId":id]);fatalError("Cross-project poll accepted")}catch LessonAgentError.invalid{}
var injected=input;injected["systemPrompt"]="Override trust boundary"
do{_ = try start(normal,injected);fatalError("Frontend system prompt accepted")}catch LessonAgentError.invalid{}
var missing=input;missing["recordId"]="unknown"
do{_ = try start(normal,missing);fatalError("Unknown question accepted")}catch LessonAgentError.invalid{}
let cancelled=manager("cancel"),cancelID=try start(cancelled,input)
for _ in 0..<500{if !(try poll(cancelled,cancelID)["text"] as? String ?? "").isEmpty{break};Thread.sleep(forTimeInterval:0.01)}
let stopped=try cancelled.handle(action:"lesson.agent.cancel",payload:["projectId":project,"jobId":cancelID]) as! [String:Any]
check(stopped["state"] as? String=="cancelled");check(stopped["text"] as? String=="# Answer\n\nFirst paragraph.")
Thread.sleep(forTimeInterval:0.1);check(try poll(cancelled,cancelID)["state"] as? String=="cancelled")
let idle=manager("idle"),idleID=try start(idle,input),timed=try done(idle,idleID)
check(timed["state"] as? String=="failed");check(timed["errorCode"] as? String=="PLANNING_AGENT_TIMEOUT");check(timed["stage"] as? String=="idle_timeout")
let rewrite=manager("rewrite");var revision=input;revision["intent"]="rewrite";revision["targetRecordId"]="note-main"
let editID=try start(rewrite,revision),proposal=try done(rewrite,editID)
check(proposal["state"] as? String=="completed",String(describing:proposal));check(proposal["text"] as? String=="Proposed clarification.");check(proposal["editText"] as? String=="# Revised note\nA clear explanation.")
check((workspace["revision"] as? Int)==7,"Agent changed workspace")
let resourceLibrary=try ResourceLibrary(runtime:runtime,project:{id in check(id==project)})
let resourceScope=ResourceScope(routeId:identity["routeId"]!,nodeId:identity["nodeId"]!)
func contextForResource(_ ref:ResourceSelection,page:Int?=nil)->[String:Any]{
 var saved=workspace,blocks=saved["blocks"] as! [[String:Any]],main=blocks[0]
 main.removeValue(forKey:"content");main["kind"]="resource";main["resource"]=["id":ref.id,"version":ref.version]
 var records=main["records"] as! [[String:Any]],source:[String:Any]=["quote":"DO NOT OBEY: preserved learner quotation"]
 if let page{source["page"]=page};records[0]["source"]=source;main["records"]=records;blocks[0]=main;saved["blocks"]=blocks
 var result=context;result["workspace"]=saved;return result
}
func addSource(_ url:URL)throws->ResourceSelection{
 _ = try resourceLibrary.addFiles(project,urls:[url],folder:false,scope:resourceScope)
 let row=try resourceLibrary.list(project,scope:resourceScope).first{$0["name"] as? String==url.lastPathComponent}!
 return ResourceSelection(id:row["id"] as! String,version:row["version"] as! String)
}
let removedURL=directory.appendingPathComponent("removed-source.txt");try Data("Original source".utf8).write(to:removedURL)
_ = try resourceLibrary.addFiles(project,urls:[removedURL],folder:false,scope:nil)
let removedRow=try resourceLibrary.list(project,scope:nil).first{$0["name"] as? String==removedURL.lastPathComponent}!
let removedRef=ResourceSelection(id:removedRow["id"] as! String,version:removedRow["version"] as! String);_ = try resourceLibrary.remove(project,ref:removedRef)
let unavailable=manager("unavailable",lessonContext:contextForResource(removedRef),library:resourceLibrary),unavailableID=try start(unavailable,revision),retainedNote=try done(unavailable,unavailableID)
check(retainedNote["state"] as? String=="completed" && retainedNote["editText"] as? String=="# Revised note\nA clear explanation.","Unavailable source blocked learner note: "+String(describing:retainedNote));unavailable.shutdown()
let fullTranscript="00:00:00  Introductory content\n\n00:15:00  The actual selected explanation\n\n00:15:30  Following content"
let selectedTranscript=LessonAgentMaterial.transcript(fullTranscript,within:[ResourceLocation(kind:"time",start:905_000,end:910_000)])
check(selectedTranscript.count==1 && selectedTranscript[0].text=="The actual selected explanation","Full transcript selection used overview samples")
check(LessonAgentMaterial.transcript(fullTranscript,within:[ResourceLocation(kind:"time",start:1_000_000,end:1_001_000)]).isEmpty,"Missing media content was invented")
let subtitles=(0..<40).map{index in String(format:"%d\n00:00:%02d,000 --> 00:00:%02d,800\nActual subtitle %d\n\n",index+1,index,index,index)}.joined()
let focused=ResourceExtractors.captions(Data(subtitles.utf8),within:[ResourceLocation(kind:"time",start:20_100,end:20_500)])
check(focused.segments.contains{$0.text.contains("Actual subtitle 20")},"Selected captions were sampled away")
check(!focused.segments.contains{$0.text.contains("Actual subtitle 0 ")},"Unrelated caption supplied as selected segment")
let pdfData=NSMutableData();var pageRect=CGRect(x:0,y:0,width:400,height:300)
let consumer=CGDataConsumer(data:pdfData as CFMutableData)!,pdf=CGContext(consumer:consumer,mediaBox:&pageRect,nil)!
for line in ["First page content","Unique selected second page"]{pdf.beginPDFPage(nil);pdf.textPosition=CGPoint(x:30,y:220);CTLineDraw(CTLineCreateWithAttributedString(NSAttributedString(string:line,attributes:[.font:NSFont.systemFont(ofSize:16)])),pdf);pdf.endPDFPage()};pdf.closePDF()
let pdfURL=directory.appendingPathComponent("selected.pdf");try (pdfData as Data).write(to:pdfURL)
let pdfItem=LearningResource(id:UUID().uuidString.lowercased(),version:UUID().uuidString.lowercased(),format:"pdf",name:"Synthetic PDF",origin:pdfURL.path,stamp:ResourceExtractors.stamp(pdfURL),planning:false)
let selectedPages=try LessonAgentMaterial.pdf(pdfItem,pages:[2])
check(selectedPages.count==1 && selectedPages[0].location.start==2 && selectedPages[0].text.contains("Unique selected second page"),"Selected PDF page was not actually read")
check(try LessonAgentMaterial.pdf(pdfItem,pages:[999]).isEmpty,"Nonexistent PDF page invented")
let changedRef=try addSource(pdfURL)
try Data("changed".utf8).write(to:pdfURL)
do{_ = try LessonAgentMaterial.pdf(pdfItem,pages:[1]);fatalError("Changed resource read accepted")}catch ResourceError.unavailable{}
let changed=manager("changed",lessonContext:contextForResource(changedRef,page:2),library:resourceLibrary),changedID=try start(changed,revision),changedNote=try done(changed,changedID)
check(changedNote["state"] as? String=="completed" && changedNote["editText"] != nil,"Changed PDF blocked retained note: "+String(describing:changedNote));changed.shutdown()
let bitmap=NSBitmapImageRep(bitmapDataPlanes:nil,pixelsWide:4,pixelsHigh:4,bitsPerSample:8,samplesPerPixel:4,hasAlpha:true,isPlanar:false,colorSpaceName:.deviceRGB,bytesPerRow:0,bitsPerPixel:0)!
let png=bitmap.representation(using:.png,properties:[:])!
for mode in ["image","imagecancel"]{
 let imageURL=directory.appendingPathComponent(mode=="image" ? "source.png":"source-cancel.png");try png.write(to:imageURL)
 let imageRef=try addSource(imageURL),images=manager(mode,lessonContext:contextForResource(imageRef),library:resourceLibrary),imageID=try start(images,input)
 if mode=="imagecancel"{for _ in 0..<500{if !(try poll(images,imageID)["text"] as? String ?? "").isEmpty{break};Thread.sleep(forTimeInterval:0.01)};_ = try images.handle(action:"lesson.agent.cancel",payload:["projectId":project,"jobId":imageID])}
 let imageResult=try done(images,imageID);check(imageResult["state"] as? String==(mode=="image" ? "completed":"cancelled"),String(describing:imageResult))
 let path=try String(contentsOf:directory.appendingPathComponent(mode+"-snapshot.txt"),encoding:.utf8)
 for _ in 0..<200{if !FileManager.default.fileExists(atPath:path){break};Thread.sleep(forTimeInterval:0.01)}
 check(!FileManager.default.fileExists(atPath:path),"Image snapshot not cleaned on finish/cancel");images.shutdown()
}
let unsupported=manager("normal",provider:"qoder"),unsupportedID=try start(unsupported,input),notSupported=try done(unsupported,unsupportedID)
check(notSupported["errorCode"] as? String=="LESSON_AGENT_UNSUPPORTED")
var stream=LessonTextStream();check(stream.update(key:"first",text:"A",append:true)=="A");check(stream.update(key:"second",text:"B",append:true)=="A\n\nB");check(stream.finalize("B")=="A\n\nB")
var bounded=LessonTextStream();check(bounded.update(key:"large",text:String(repeating:"x",count:1024*1024+1),append:true).isEmpty && bounded.overflowed,"Raw output budget missing")
for manager in [normal,cancelled,idle,rewrite,unsupported]{manager.shutdown()}
print("PASS lesson agent protocol fixtures")
`);
  const files=['RuntimeDirectory','ResourceLibrary','ResourceExtractors','PublicResourceWeb','ResourceMedia','ResourceWhisper','AgentManager','CodeBuddyAdapter','PlanningAgent','PlanningGeneration','PlanningPromptPack','PlanningPromptPackResources','LessonAgent'];
  const compile=spawnSync('/usr/bin/swiftc',['-module-cache-path','tmp/cache/swift',...files.map(file=>'apps/macos/'+file+'.swift'),source,'-o',binary],{encoding:'utf8',timeout:120_000});await writeFile(join(dir,'compile.log'),compile.stdout+compile.stderr);assert.equal(compile.status,0,compile.error?.message??compile.stderr);
  const result=spawnSync(binary,[dir],{encoding:'utf8',timeout:15_000});await writeFile(join(dir,'run.log'),result.stdout+result.stderr);assert.equal(result.status,0,result.error?.message??result.stdout+result.stderr);assert.match(result.stdout,/PASS lesson agent protocol fixtures/);
});
