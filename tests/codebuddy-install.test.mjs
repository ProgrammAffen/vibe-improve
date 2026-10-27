import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,copyFile,access,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';

const source=resolve('apps/macos/resources/codebuddy-cli/manager.mjs');
const hash=value=>createHash('sha256').update(value).digest('hex');
async function fixture(){
  await mkdir('tmp/checks/codebuddy-installer',{recursive:true});
  const root=await mkdtemp('tmp/checks/codebuddy-installer/case-'),resources=join(root,'resources'),working=join(root,'runtime');
  await mkdir(resources);await mkdir(working);await copyFile(source,join(resources,'manager.mjs'));
  for(const file of ['package.json','package-lock.json','distribution.json'])await copyFile(resolve('apps/macos/resources/codebuddy-cli',file),join(resources,file));
  return {root,resources,working,manager:join(resources,'manager.mjs')};
}
test('CodeBuddy release is locked to official registry with integrity; no WorkBuddy dependency',async()=>{
  const root='apps/macos/resources/codebuddy-cli',lock=JSON.parse(await readFile(join(root,'package-lock.json'),'utf8'));
  assert.equal(lock.packages[''].dependencies['@tencent-ai/codebuddy-code'],'2.177.0');
  for(const value of Object.values(lock.packages))if(value.resolved){assert.equal(new URL(value.resolved).origin,'https://registry.npmjs.org');assert.match(value.integrity,/^sha512-/)}
  const spec=JSON.parse(await readFile(join(root,'distribution.json'),'utf8'));
  assert.equal(spec.integrity,lock.packages['node_modules/@tencent-ai/codebuddy-code'].integrity);
  assert.ok(Object.keys(spec.files).length>100);
});
test('discovery verifies package bytes without executing a same-name CLI',async()=>{
  const f=await fixture(),pkg=join(f.root,'package'),entry=join(pkg,'bin/codebuddy'),marker=join(f.root,'must-not-execute');
  await mkdir(join(pkg,'bin'),{recursive:true});
  const metadata=JSON.stringify({name:'@tencent-ai/codebuddy-code',version:'2.177.0'}),script=`require('node:fs').writeFileSync(${JSON.stringify(resolve(marker))},'bad');`;
  await writeFile(join(pkg,'package.json'),metadata);await writeFile(entry,script);
  const spec={name:'@tencent-ai/codebuddy-code',version:'2.177.0',files:{'package.json':hash(metadata),'bin/codebuddy':hash(script)}};
  await writeFile(join(f.resources,'distribution.json'),JSON.stringify(spec));
  const run=()=>spawnSync(process.execPath,[f.manager,'resolve',f.working,entry],{encoding:'utf8'});
  assert.equal(JSON.parse(run().stdout).state,'installed');await assert.rejects(access(marker));
  await writeFile(entry,'modified');assert.equal(JSON.parse(run().stdout).state,'unverified');await assert.rejects(access(marker));
});
async function fakeNpm(f,script){
  const pkg=join(f.root,'npm');await mkdir(join(pkg,'bin'),{recursive:true});
  await writeFile(join(pkg,'package.json'),JSON.stringify({name:'npm'}));
  const file=join(pkg,'bin/npm-cli.js');await writeFile(file,script);return file;
}
test('failed verification preserves previous installation and clears staging; errors contain no raw output',async()=>{
  const f=await fixture(),previous=join(f.working,'cli-2.177.0');await mkdir(previous);await writeFile(join(previous,'preserve'),'previous');
  const npm=await fakeNpm(f,`console.error('EINTEGRITY PRIVATE_TEST_TOKEN');process.exit(1);`);
  const result=spawnSync(process.execPath,[f.manager,'install',f.working,npm],{encoding:'utf8',timeout:15000});
  assert.equal(result.status,1);assert.ok(result.stdout.includes('AGENT_INTEGRITY_FAILED'));assert.ok(!result.stdout.includes('PRIVATE'));assert.equal(result.stderr,'');
  assert.equal(await readFile(join(previous,'preserve'),'utf8'),'previous');assert.equal((await readdir(f.working)).some(x=>x.startsWith('.install-')),false);
});
test('cancel installation terminates npm and preserves the existing installation',async()=>{
  const f=await fixture(),previous=join(f.working,'cli-2.177.0');await mkdir(previous);await writeFile(join(previous,'preserve'),'previous');
  const npm=await fakeNpm(f,`setInterval(()=>{},1000);`);
  const process_=spawn(process.execPath,[f.manager,'install',f.working,npm],{stdio:['ignore','pipe','pipe']});
  const closed=new Promise((yes,no)=>{process_.once('error',no);process_.once('close',yes)});
  await new Promise((yes,no)=>{process_.stdout.once('data',yes);process_.once('error',no)});
  process_.kill('SIGTERM');await closed;
  assert.equal(await readFile(join(previous,'preserve'),'utf8'),'previous');assert.equal((await readdir(f.working)).some(x=>x.startsWith('.install-')),false);
});
