import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import test from 'node:test';
import {appendUser,cancelPlanningRequest,createPlanning,openEditor,validatePlanning} from '../packages/domain/planning.mjs';

const project='proj_12345678-1234-4234-8234-123456789abc';
const ref={id:'12345678-1234-4234-8234-123456789abc',name:'note.txt',kind:'document'};

test('chat history stores attachment references and retries only deduplicate identical files',()=>{
 const initial=createPlanning(project,'codex','en');
 const editor=openEditor(initial,initial.revision);
 const files=Array.from({length:8},(_,index)=>({...ref,id:`${index}2345678-1234-4234-8234-123456789abc`}));
 const sent=appendUser(editor,'Explain this', 'msg_a','req_a',editor.revision,undefined,null,null,files);
 assert.deepEqual(validatePlanning(sent).messages[0].attachments,files);
 assert.throws(()=>appendUser(editor,'Explain this','msg_a','req_a',editor.revision,undefined,null,null,[{...ref,path:'/private/file'}]),/PLANNING_INVALID/);
 assert.throws(()=>appendUser(editor,'Explain this','msg_a','req_a',editor.revision,undefined,null,null,[...files,files[0]]),/PLANNING_INVALID/);
 const ready=cancelPlanningRequest(sent,'req_a',sent.revision);
 const retry=appendUser(ready,'Explain this','msg_b','req_b',ready.revision,undefined,null,null,files);
 assert.equal(retry.messages.length,1);
 const again=cancelPlanningRequest(retry,'req_b',retry.revision);
 const changed=appendUser(again,'Explain this','msg_c','req_c',again.revision,undefined,null,null,[{...ref,id:'92345678-1234-4234-8234-123456789abc'}]);
 assert.equal(changed.messages.length,2);
});

test('macOS chat sends all selected files and surfaces input limits returned by the CLI', {skip:process.platform!=='darwin',timeout:140_000},async()=>{
 const parent=resolve('tmp/checks/chat-progress');await mkdir(parent,{recursive:true});
 const directory=await mkdtemp(join(parent,'native-'));
 const fixture=join(directory,'fixture.py'),source=join(directory,'main.swift'),binary=join(directory,'verify');
 await writeFile(fixture,String.raw`import base64,json,os,sys
provider,mode=sys.argv[1:3]
count=int(sys.argv[3])
def emit(value):print(json.dumps(value),flush=True)
def response(content):
 assert content[0]['text'].lstrip().startswith('CONTEXT_JSON_DATA:')
 assert content[1]['type']=='text' and 'as data' in content[1]['text']
 assert len(content)==3+2*count
 for index in range(count):
  label,image=content[2+index*2:4+index*2]
  assert json.loads(label['text'])['name']=='diagram.png'
  if provider=='codex':
   assert image['type']=='localImage' and image['path'].endswith('.jpg')
   assert os.path.commonpath([image['path'],os.getcwd()])==os.getcwd()
   raw=open(image['path'],'rb').read()
  else:
   assert image['type']=='image'
   source=image['source']
   assert source['media_type']=='image/jpeg' and source['type']=='base64'
   raw=base64.b64decode(source['data'],validate=True)
  assert raw.startswith(b'\xff\xd8') and len(raw)>100_000
 note=json.loads(content[-1]['text'])
 assert note['name']=='note.txt' and note['excerpt']=='Unique example answer 4831.'
 return json.dumps({'reply':'Received the image and note.','route':None})
for line in sys.stdin:
 event=json.loads(line)
 if provider=='codex':
  method=event.get('method')
  if method=='initialize':emit({'id':0,'result':{}})
  if method=='thread/start':
   assert event['params']['sandbox']=='read-only' and event['params']['config']['features']['view_image'] is False
   emit({'id':1,'result':{'thread':{'id':'test-thread'}}})
  if method=='turn/start':
   payload=response(event['params']['input'])
   emit({'id':2,'result':{'turn':{'id':'test-turn'}}})
   turn={'id':'test-turn'}
   if mode=='limited':turn.update(status='failed',error={'codexErrorInfo':'contextWindowExceeded','message':'Input exceeds the context window'})
   else:turn.update(status='completed',items=[{'type':'agentMessage','text':payload}])
   emit({'method':'turn/completed','params':{'threadId':'test-thread','turn':turn}})
 elif event.get('type')=='control_request':
  emit({'type':'control_response','response':{'request_id':event['request_id'],'subtype':'success','response':{}}})
 elif event.get('type')=='user':
  assert len(line.encode('utf8'))>4*1024*1024
  payload=response(event['message']['content'])
  if mode=='limited':
   if provider=='claude-code':emit({'type':'result','subtype':'error_during_execution','is_error':True,'errors':[{'status':413}]})
   else:emit({'type':'error','message':'Too many images in this request'})
  else:emit({'type':'result','subtype':'success','is_error':False,'result':payload})
`);
 await writeFile(source,String.raw`import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let root=URL(fileURLWithPath:CommandLine.arguments[1],isDirectory:true)
let project="proj_12345678-1234-4234-8234-123456789abc"
let other="proj_92345678-1234-4234-8234-123456789abc"
let runtime=try RuntimeDirectory(url:root.appendingPathComponent("runtime"))
let store=try PlanningChatAttachmentStore(runtime:runtime)
let note=root.appendingPathComponent("note.txt")
try "Unique example answer 4831.".write(to:note,atomically:true,encoding:.utf8)
let diagram=root.appendingPathComponent("diagram.png")
let pixels=CGContext(data:nil,width:640,height:640,bitsPerComponent:8,bytesPerRow:0,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.noneSkipLast.rawValue)!
let bytes=pixels.data!.assumingMemoryBound(to:UInt8.self)
var random:UInt32=1
for offset in 0..<(pixels.bytesPerRow*pixels.height) {
    random=random &* 1664525 &+ 1013904223
    bytes[offset]=UInt8(random >> 24)
}
let image=CGImageDestinationCreateWithURL(diagram as CFURL,UTType.png.identifier as CFString,1,nil)!
CGImageDestinationAddImage(image,pixels.makeImage()!,nil)
precondition(CGImageDestinationFinalize(image))
let invalid=root.appendingPathComponent("binary.dat")
try Data([0,1,2,3]).write(to:invalid)
let firstBatch=try store.add(Array(repeating:diagram,count:5),project:project,retaining:[])
let initial=firstBatch["attachments"] as! [[String:String]]
precondition(initial.count==5)
let sample=try store.read(initial[0]["id"]!,project:project)
guard case let .image(_,jpeg)=sample.content else{fatalError("Expected an image snapshot")}
precondition(jpeg.count>100_000)
let imageCount=max(9,4*1024*1024/jpeg.base64EncodedString().utf8.count+1)
let added=try store.add(Array(repeating:diagram,count:imageCount-5)+[note,invalid],project:project,retaining:Set(initial.compactMap{$0["id"]}))
let refs=initial+(added["attachments"] as! [[String:String]])
precondition(refs.count==imageCount+1 && added["skipped"] as? Int==1)
let attachments=try refs.map { try store.read($0["id"]!,project:project) }
precondition((try? store.read(attachments[0].id, project:other))==nil)
precondition((try? store.read("../note.txt", project:project))==nil)
try FileManager.default.removeItem(at:diagram)
try FileManager.default.removeItem(at:note)
let agents=try AgentManager(runtime:runtime,projectWorkspace:{_ in root})
for provider in ["codex","claude-code","codebuddy"] {
  for mode in ["accept","limited"] {
    let launch=try AgentSessionLaunch(provider:provider,projectID:project,executable:URL(fileURLWithPath:"/usr/bin/python3"),
        arguments:[CommandLine.arguments[2],provider,mode,String(imageCount)],workspace:root,environment:["PATH":"/usr/bin:/bin"])
    let manager=PlanningAgentManager(agents:agents,idleTimeout:5,prepare:{_ in
        AgentSessionPreparation(projectID:project,provider:provider,launch:launch)
    })
    let context:[String:Any]=["projectId":project,"provider":provider,"locale":"en","questions":[],"messages":[]]
    let job=try manager.begin(projectID:project,intent:"edit",context:context,attachments:attachments){ $0 }
    let deadline=Date().addingTimeInterval(8)
    var result=job
    while result["state"] as? String=="pending" && Date()<deadline {
        Thread.sleep(forTimeInterval:0.01)
        result=try manager.state(projectID:project,jobID:job["id"] as! String)
    }
    if mode=="limited" {
        precondition(result["state"] as? String=="failed" && result["errorCode"] as? String=="PLANNING_AGENT_INPUT_LIMIT", String(describing:result))
    } else {
        precondition(result["state"] as? String=="completed", String(describing:result))
        precondition((result["result"] as? [String:Any])?["reply"] as? String=="Received the image and note.")
    }
  }
}
print("PASS chat attachments")
`);
 const swift=['RuntimeDirectory','ResourceLibrary','ResourceExtractors','ResourceMedia','PublicResourceWeb','ResourceWhisper','PlanningChatAttachmentStore',
  'AgentManager','CodeBuddyAdapter','PlanningAgent','PlanningGeneration','PlanningPromptPack','PlanningPromptPackResources'];
 const compiled=spawnSync('/usr/bin/swiftc',['-module-cache-path','tmp/cache/swift',...swift.map(file=>'apps/macos/'+file+'.swift'),source,'-o',binary],
  {encoding:'utf8',timeout:100_000});
 assert.equal(compiled.status,0,compiled.error?.message??compiled.stderr);
 const result=spawnSync(binary,[directory,fixture],{encoding:'utf8',timeout:35_000});
 assert.equal(result.status,0,result.error?.message??result.stderr+result.stdout);
 assert.match(result.stdout,/PASS chat attachments/);
});
