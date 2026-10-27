import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import ts from 'typescript';
import {readFile,mkdir,mkdtemp,writeFile,stat,rm,symlink} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url)),base=join(root,'tmp/checks/project-drafts');
const compile=async file=>ts.transpileModule(await readFile(join(root,file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const domain={exports:{}};
vm.runInNewContext(await compile('apps/local-ui/src/projects/domain.ts'),{module:domain,exports:domain.exports,TextEncoder});
const {validProjectName,validateProject,selectProjects}=domain.exports;
const now='2026-10-23T06:00:00.000Z';
const document=(name='Synthetic quest')=>({format:'vibe-improve.project',schemaVersion:1,id:'proj_'+randomUUID(),name,revision:1,createdAt:now,updatedAt:now,lastOpenedAt:now,state:'draft'});

test('project names reject traversal, cross-platform reserved files and overlong UTF-8 names',()=>{
  for(const name of ['','..',' a','a ','a.','../escape','folder/name','bad\\path','a:b','CON','con.txt','LPT9','COM1.md','hidden\u202e','a\n','x'.repeat(81),'😀'.repeat(80)])assert.equal(validProjectName(name),false,name);
  for(const name of ['提升计划','Café','Cafe\u0301','Portfolio 2026','a'.repeat(80),'中'.repeat(80),'😀'.repeat(63)])assert.equal(validProjectName(name),true,name);
});

test('unplanned projects never inherit fabricated progress and invalid metadata does not reach the UI',()=>{
  const value=document();
  const p=validateProject({...value,completedNodes:22,totalNodes:30,path:'/synthetic'});
  assert.equal(p.completedNodes,0);assert.equal(p.totalNodes,0);assert.equal(p.path,'/synthetic');
  for(const change of [{schemaVersion:2},{id:'proj_'+'-'.repeat(36)},{revision:0},{revision:1.5},{name:'../escape'},{state:'ready'},{lastOpenedAt:'invalid'}])assert.throws(()=>validateProject({...value,...change}),/PROJECT_INVALID/);
  const records=[validateProject({...value,name:'数据分析',lastOpenedAt:'2026-10-22T00:00:00Z'}),validateProject({...document('English practice'),lastOpenedAt:now})];
  assert.equal(selectProjects(records,' ENGLISH ','recent')[0].name,'English practice');
  assert.equal(selectProjects(records,'','recent')[0].name,'English practice');
  assert.equal(records[0].name,'数据分析');
});

test('native project bridge receives opaque grants and diagnostic events omit names and paths',async()=>{
  const calls=[],logs=[],exports={exports:{}};
  const record=document('PRIVATE_QUEST');
  vm.runInNewContext(await compile('apps/local-ui/src/projects/service.ts'),{
    module:exports,exports:exports.exports,performance,TextEncoder,
    window:{vibeNative:{projects:{request:async(action,value)=>{calls.push({action,value});if(action==='create')return{...record,path:'/PRIVATE_LOCATION'};if(action==='list')return[record];if(action==='remove')return null;throw new Error('PROJECT_EXISTS /PRIVATE_LOCATION');}}}},
    require:name=>name==='./domain'?domain.exports:{logEvent:(...args)=>logs.push(args)},
  });
  const service=exports.exports.projectService;
  await service.create('PRIVATE_QUEST',{token:'opaque-grant',path:'/PRIVATE_LOCATION',name:'PRIVATE_LOCATION'},randomUUID());
  assert.equal(calls[0].value.parentToken,'opaque-grant');assert.equal('path' in calls[0].value,false);
  await assert.rejects(service.open(record.id),/^Error: PROJECT_EXISTS$/);
  assert.equal((await service.list()).length,1);
  await service.remove({...record,kind:'draft',path:'/PRIVATE_LOCATION',available:true,completedNodes:0,totalNodes:0});
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))),{action:'remove',value:{id:record.id,expectedRevision:1}});
  assert.ok(!JSON.stringify(logs).includes('PRIVATE_'));assert.ok(logs.some(v=>v[0]==='operation.failed'));
});

const options={skip:process.platform!=='darwin',timeout:120_000};
let executable;
async function binary(){
  return executable??=(async()=>{
    await mkdir(base,{recursive:true});const build=await mkdtemp(join(base,'build-')),source=join(build,'main.swift'),out=join(build,'project-test');
    await writeFile(source,`import Foundation
let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
do {
    let data = FileManager.default.contents(atPath: CommandLine.arguments[2])!
    let input = try JSONSerialization.jsonObject(with: data) as! [String: Any]
    let store = try ProjectStore(runtime: RuntimeDirectory(url: root))
    let action = input["action"] as! String
    var token: String? = nil
    if let path = input["parent"] as? String { token = try store.grant(URL(fileURLWithPath: path))["token"] as? String }
    var result: Any = NSNull()
    switch action {
    case "list": result = try store.list()
    case "create": result = try store.create(name: input["name"] as! String, parentToken: token ?? "forged", commandID: input["commandId"] as! String)
    case "open": result = try store.openProject(id: input["id"] as! String)
    case "update": result = try store.rename(id: input["id"] as! String, name: input["name"] as! String, expectedRevision: input["revision"] as! Int, parentToken: token)
    case "remove": try store.remove(id: input["id"] as! String, expectedRevision: input["revision"] as! Int)
    case "draft.save": try store.saveDraft(name: input["name"] as! String, parentToken: token)
    case "draft.read": result = try store.loadDraft()
    case "register": result = try store.register(URL(fileURLWithPath: input["path"] as! String), replacing: input["id"] as? String)
    default: throw ProjectError.invalid
    }
    print(String(data: try JSONSerialization.data(withJSONObject: result, options: [.fragmentsAllowed]), encoding: .utf8)!)
} catch { print((error as? ProjectError)?.rawValue ?? "PROJECT_STORAGE_UNAVAILABLE"); exit(3) }
`);
    const built=spawnSync('/usr/bin/swiftc',['-module-cache-path',join(root,'tmp/cache/swift'),join(root,'apps/macos/RuntimeDirectory.swift'),join(root,'apps/macos/ProjectStore.swift'),source,'-o',out],{cwd:root,encoding:'utf8'});
    assert.equal(built.status,0,built.stderr);return out;
  })();
}
async function fixture(){
  const bin=await binary(),dir=await mkdtemp(join(base,'run-')),runtime=join(dir,'Runtime'),parent=join(dir,'Chosen parent');await mkdir(parent,{mode:0o755});
  async function run(input,failure){
    const source=join(dir,'input-'+randomUUID()+'.json');await writeFile(source,JSON.stringify(input));
    const result=spawnSync(bin,[runtime,source],{cwd:root,encoding:'utf8'});assert.equal(result.status,failure?3:0,result.stderr+result.stdout);
    return failure?result.stdout.trim():JSON.parse(result.stdout);
  }
  return{dir,parent,runtime,run};
}

test('desktop drafts survive restart with folder bookmarks without writing a premature project folder',options,async()=>{
  const f=await fixture(),commandId=randomUUID(),value={action:'create',name:'Synthetic project',parent:f.parent,commandId};
  const created=await f.run(value),again=await f.run(value);assert.equal(again.id,created.id);assert.equal(again.revision,1);
  await assert.rejects(stat(join(f.parent,'Synthetic project')),{code:'ENOENT'});
  assert.equal((await stat(f.parent)).mode&0o777,0o755);
  assert.equal((await f.run({action:'list'})).length,1);
  const opened=await f.run({action:'open',id:created.id});assert.equal(opened.directory.path,f.parent);assert.ok(opened.directory.token);
  await f.run({action:'draft.save',name:'Unfinished form',parent:f.parent});const restored=await f.run({action:'draft.read'});assert.equal(restored.name,'Unfinished form');assert.equal(restored.directory.path,f.parent);
  assert.equal((await stat(join(f.runtime,'projects/index.json'))).mode&0o777,0o600);
});

test('draft commands reject duplicates, unsafe names, forged directory grants and stale revisions',options,async()=>{
  const f=await fixture(),commandId=randomUUID();
  const created=await f.run({action:'create',name:'Alpha',parent:f.parent,commandId});
  assert.equal(await f.run({action:'create',name:'Beta',parent:f.parent,commandId},true),'PROJECT_CONFLICT');
  assert.equal(await f.run({action:'create',name:'alpha',parent:f.parent,commandId:randomUUID()},true),'PROJECT_EXISTS');
  for(const name of ['../escape','CON','bad\\path','😀'.repeat(80)])assert.equal(await f.run({action:'create',name,parent:f.parent,commandId:randomUUID()},true),'PROJECT_NAME_INVALID');
  assert.equal(await f.run({action:'create',name:'Beta',commandId:randomUUID()},true),'PROJECT_DIRECTORY_REQUIRED');
  const updated=await f.run({action:'update',id:created.id,name:'Beta',revision:1});assert.equal(updated.revision,2);
  assert.equal(await f.run({action:'update',id:created.id,name:'Stale',revision:1},true),'PROJECT_CONFLICT');
  await mkdir(join(f.parent,'Occupied'));
  assert.equal(await f.run({action:'update',id:created.id,name:'Occupied',revision:2},true),'PROJECT_EXISTS');
});

test('missing folders retain their index record and can be explicitly relocated',options,async()=>{
  const f=await fixture(),created=await f.run({action:'create',name:'Recovery',parent:f.parent,commandId:randomUUID()});
  await rm(f.parent,{recursive:true});assert.equal((await f.run({action:'list'}))[0].available,false);
  assert.equal(await f.run({action:'open',id:created.id},true),'PROJECT_UNAVAILABLE');
  const replacement=join(f.dir,'Replacement');await mkdir(replacement);
  await f.run({action:'update',id:created.id,name:'Recovery',revision:1,parent:replacement});
  const record=(await f.run({action:'list'}))[0];assert.equal(record.available,true);assert.equal(record.path,join(replacement,'Recovery'));
});

test('corrupt or symlinked draft indexes fail without discarding or changing existing data',options,async()=>{
  const f=await fixture();await f.run({action:'list'});const index=join(f.runtime,'projects/index.json');
  await writeFile(index,'CORRUPT');assert.equal(await f.run({action:'list'},true),'PROJECT_STORAGE_UNAVAILABLE');assert.equal(await readFile(index,'utf8'),'CORRUPT');
  await rm(index);const outside=join(f.dir,'untouched');await writeFile(outside,'UNCHANGED',{mode:0o644});await symlink(outside,index);
  await f.run({action:'list'},true);assert.equal(await readFile(outside,'utf8'),'UNCHANGED');assert.equal((await stat(outside)).mode&0o777,0o644);
});

test('opening a compatible local draft validates format and optimistic revisions before updates',options,async()=>{
  const f=await fixture(),project=join(f.dir,'Portable'),marker=join(project,'.vibe-improve');await mkdir(marker,{recursive:true});
  const doc=document('Portable draft'),file=join(marker,'project.json');await writeFile(file,JSON.stringify(doc));
  const record=await f.run({action:'register',path:project});assert.equal(record.kind,'project');
  const opened=await f.run({action:'open',id:record.id});assert.equal(opened.kind,'project');
  const updated=await f.run({action:'update',id:record.id,name:'Renamed draft',revision:1});assert.equal(updated.revision,2);
  assert.equal(JSON.parse(await readFile(file,'utf8')).name,'Renamed draft');
  assert.equal(await f.run({action:'update',id:record.id,name:'Stale',revision:1},true),'PROJECT_CONFLICT');
  await writeFile(file,JSON.stringify({...doc,schemaVersion:9}));assert.equal((await f.run({action:'list'}))[0].available,false);
});

test('removing a project survives restart, is idempotent, and preserves every project file',options,async()=>{
  const f=await fixture(),project=join(f.dir,'Keep files'),marker=join(project,'.vibe-improve');await mkdir(marker,{recursive:true});
  const doc=document('Keep files'),file=join(marker,'project.json'),material=join(project,'learning-notes.txt');
  await writeFile(file,JSON.stringify(doc));await writeFile(material,'SYNTHETIC LEARNING NOTES');
  const record=await f.run({action:'register',path:project}),before=await readFile(file,'utf8');
  await f.run({action:'remove',id:record.id,revision:record.revision});
  assert.equal((await f.run({action:'list'})).length,0);
  assert.equal(await f.run({action:'remove',id:record.id,revision:record.revision}),null);
  assert.equal(await readFile(file,'utf8'),before);assert.equal(await readFile(material,'utf8'),'SYNTHETIC LEARNING NOTES');
  assert.equal((await f.run({action:'register',path:project})).id,record.id);
});

test('removal rejects stale or invalid commands without changing the index and can remove unavailable drafts',options,async()=>{
  const f=await fixture(),record=await f.run({action:'create',name:'Draft stays until confirmed',parent:f.parent,commandId:randomUUID()});
  const updated=await f.run({action:'update',id:record.id,name:'New revision',revision:1});
  const index=join(f.runtime,'projects/index.json'),before=await readFile(index,'utf8');
  assert.equal(await f.run({action:'remove',id:record.id,revision:1},true),'PROJECT_CONFLICT');
  assert.equal(await readFile(index,'utf8'),before);
  for(const value of [{id:'../index',revision:1},{id:record.id,revision:0},{id:record.id,revision:1_000_000}])assert.equal(await f.run({action:'remove',...value},true),'PROJECT_INVALID');
  assert.equal((await f.run({action:'list'})).length,1);
  await rm(f.parent,{recursive:true});
  assert.equal((await f.run({action:'list'}))[0].available,false);
  await f.run({action:'remove',id:record.id,revision:updated.revision});
  assert.equal((await f.run({action:'list'})).length,0);
  assert.equal(await f.run({action:'update',id:record.id,name:'No resurrection',revision:updated.revision},true),'PROJECT_UNAVAILABLE');
});

test('portable project removal checks an external revision without modifying its document',options,async()=>{
  const f=await fixture(),project=join(f.dir,'External revision'),marker=join(project,'.vibe-improve');await mkdir(marker,{recursive:true});
  const doc=document('External revision'),file=join(marker,'project.json');await writeFile(file,JSON.stringify(doc));
  const record=await f.run({action:'register',path:project});
  const changed=JSON.stringify({...doc,revision:2,name:'Modified elsewhere'});await writeFile(file,changed);
  assert.equal(await f.run({action:'remove',id:record.id,revision:1},true),'PROJECT_CONFLICT');
  const current=(await f.run({action:'list'}))[0];assert.equal(current.revision,2);
  await f.run({action:'remove',id:current.id,revision:current.revision});
  assert.equal((await f.run({action:'list'})).length,0);assert.equal(await readFile(file,'utf8'),changed);
});
