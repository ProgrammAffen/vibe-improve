import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,mkdtemp,writeFile,stat,readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {build} from 'esbuild';
import {parseRoute,MAX_ROUTE_BYTES} from '../packages/domain/route-validation.mjs';

const root=resolve('.'),base=join(root,'tmp/checks/route-import');
const text=await readFile('contracts/examples/route.valid.json','utf8'),sample=JSON.parse(text);
test('route import enforces strict JSON, versions, Unicode, structure and dependency graph without requiring optional assessment',()=>{
  assert.equal(parseRoute(text).id,sample.id);
  const optional=structuredClone(sample);delete optional.chapters[0].nodes[0].assessment;assert.equal(parseRoute(JSON.stringify(optional)).chapters.length,2);
  const cases=[['{"format":"x","format":"y"}','ROUTE_DUPLICATE_KEYS'],['{"a":1,"\\u0061":2}','ROUTE_DUPLICATE_KEYS'],['[NaN]','ROUTE_INVALID_JSON'],['[1e999]','ROUTE_INVALID'],['[01]','ROUTE_INVALID_JSON'],['{} trailing','ROUTE_INVALID_JSON'],['{"x":"\\ud800"}','ROUTE_INVALID_JSON'],['['.repeat(18)+'0'+']'.repeat(18),'ROUTE_DEPTH_LIMIT'],[' '.repeat(MAX_ROUTE_BYTES+1),'ROUTE_TOO_LARGE']];
  for(const [raw,code] of cases)assert.throws(()=>parseRoute(raw),{message:code});
  const invalid=[{...sample,schemaVersion:2},{...sample,extra:'untrusted'}];
  const cycle=structuredClone(sample);cycle.chapters[0].nodes[0].prerequisites=[cycle.chapters[1].nodes[0].id];invalid.push(cycle);
  const duplicate=structuredClone(sample);duplicate.chapters[1].nodes[0].id=duplicate.chapters[0].nodes[0].id;invalid.push(duplicate);
  const empty=structuredClone(optional);empty.chapters[0].nodes[0].assessment={};invalid.push(empty);
  for(const value of invalid)assert.throws(()=>parseRoute(JSON.stringify(value)),/ROUTE_/);
});
test('JavaScript and existing Python route validators accept the same bounded sample cases',async()=>{
  await mkdir(base,{recursive:true});const dir=await mkdtemp(join(base,'parity-'));
  const cases=[sample,(()=>{const r=structuredClone(sample);delete r.chapters[0].nodes[0].assessment;return r})(),{...sample,schemaVersion:9},{...sample,chapters:[]},{...sample,title:'\n '},{...sample,foo:1}];
  for(let index=0;index<cases.length;index++){
    const file=join(dir,index+'.json'),value=JSON.stringify(cases[index]);await writeFile(file,value);
    let accepted=true;try{parseRoute(value)}catch{accepted=false}
    let result=spawnSync('python3',['-B','scripts/validate_route.py',file],{cwd:root,encoding:'utf8'});
    if(process.platform==='darwin'&&result.status!==0&&result.stderr.includes('incompatible architecture'))result=spawnSync('/usr/bin/arch',['-arm64','/Library/Developer/CommandLineTools/usr/bin/python3','-B','scripts/validate_route.py',file],{cwd:root,encoding:'utf8'});
    assert.equal(result.status===0,accepted,result.stderr);
  }
});
test('native import uses the same validator, saves only confirmed drafts, rejects stale grants and preserves files across restart',{skip:process.platform!=='darwin',timeout:180_000},async()=>{
  await mkdir(base,{recursive:true});const dir=await mkdtemp(join(base,'native-')),validator=join(dir,'validator.js'),source=join(dir,'main.swift'),binary=join(dir,'test');
  await build({entryPoints:['packages/domain/route-validation.mjs'],bundle:true,format:'iife',globalName:'VibeRoute',platform:'neutral',target:'es2022',outfile:validator});
  const chosen=join(dir,'Chosen project'),runtime=join(dir,'Runtime'),file=join(dir,'synthetic-route.json');await mkdir(chosen);await writeFile(file,text,{mode:0o644});
  const invalid=join(dir,'invalid.json');await writeFile(invalid,'{"format":"vibe-improve.route","format":"x"}');
  await writeFile(source,`import Foundation
func check(_ value:Bool){precondition(value)}
let root=URL(fileURLWithPath:CommandLine.arguments[1]),validator=URL(fileURLWithPath:CommandLine.arguments[2]),chosen=URL(fileURLWithPath:CommandLine.arguments[3])
let file=URL(fileURLWithPath:CommandLine.arguments[4]),invalid=URL(fileURLWithPath:CommandLine.arguments[5])
let project="proj_12345678-1234-4234-8234-123456789abc",other="proj_12345678-1234-4234-8234-123456789abd"
func store()throws->RoutePreparationStore{try RoutePreparationStore(runtime:RuntimeDirectory(url:root),validatorURL:validator,workspace:{id in guard id==project else{throw ProjectError.unavailable};return chosen})}
let first=try store();check(try first.read(projectID:project)["revision"] as? Int==0)
do{_ = try first.read(projectID:other);preconditionFailure()}catch RoutePreparationError.project{}
let confirmed=try first.confirmAgent(projectID:project);check(confirmed["revision"] as? Int==1)
check(try first.confirmAgent(projectID:project)["revision"] as? Int==1)
_ = try first.choose(projectID:project,source:"import",aiAssisted:false,expectedRevision:1)
do{_ = try first.stage(projectID:project,url:invalid);preconditionFailure()}catch RoutePreparationError.duplicate{}
check(try first.read(projectID:project)["routeDraft"]==nil)
let staged=try first.stage(projectID:project,url:file),token=staged["importId"] as! String
do{_ = try first.saveImport(projectID:other,importID:token,expectedRevision:2);preconditionFailure()}catch RoutePreparationError.project{}
let saved=try first.saveImport(projectID:project,importID:token,expectedRevision:2);check(saved["revision"] as? Int==3)
let reopened=try store();check(try reopened.read(projectID:project)["routeDraft"] != nil)
let retry=try first.stage(projectID:project,url:file),retryID=retry["importId"] as! String
do{_ = try first.saveImport(projectID:project,importID:retryID,expectedRevision:2);preconditionFailure()}catch RoutePreparationError.conflict{}
check(try first.read(projectID:project)["revision"] as? Int==3)
try first.cancelImport(projectID:project,importID:retryID)
do{_ = try first.saveImport(projectID:project,importID:retryID,expectedRevision:3);preconditionFailure()}catch RoutePreparationError.expired{}
print("PASS native import and persistence")
`);
  const result=spawnSync('/usr/bin/swiftc',['-module-cache-path',join(root,'tmp/cache/swift'),'-framework','JavaScriptCore','apps/macos/RuntimeDirectory.swift','apps/macos/ProjectStore.swift','apps/macos/RoutePreparationStore.swift',source,'-o',binary],{cwd:root,encoding:'utf8'});assert.equal(result.status,0,result.stderr);
  const run=spawnSync(binary,[runtime,validator,chosen,file,invalid],{encoding:'utf8'});assert.equal(run.status,0,run.stderr+run.stdout);
  assert.match(run.stdout,/PASS/);assert.equal(await readFile(file,'utf8'),text);assert.equal((await stat(file)).mode&0o777,0o644);assert.deepEqual(await readdir(chosen),[]);
});
