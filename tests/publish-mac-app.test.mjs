import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile,lstat,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {publishMacApp} from '../scripts/publish-mac-app.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
async function fixture() {
  const base=join(root,'tmp/checks/publish-mac-app');await mkdir(base,{recursive:true});
  const dir=await mkdtemp(join(base,'run-'));await mkdir(join(dir,'tmp/build/macos'),{recursive:true});
  const stage=join(dir,'tmp/build/macos/Vibe Improve.app');
  const prepare=async version=>{await mkdir(stage,{recursive:true});await writeFile(join(stage,'version'),version);};
  return {dir,stage,prepare};
}
test('publishes an unpacked application, overwrites the old bundle and preserves runtime data',async()=>{
  const f=await fixture();await f.prepare('old');const target=await publishMacApp(f.dir,f.stage);
  assert.equal(target,join(f.dir,'output/Vibe Improve.app'));assert.equal(await readFile(join(target,'version'),'utf8'),'old');
  const runtime=join(f.dir,'output/Vibe Improve Runtime');await mkdir(runtime);await writeFile(join(runtime,'preferences.json'),'SYNTHETIC_PREFERENCES');
  await f.prepare('new');await publishMacApp(f.dir,f.stage);
  assert.equal(await readFile(join(target,'version'),'utf8'),'new');assert.equal(await readFile(join(runtime,'preferences.json'),'utf8'),'SYNTHETIC_PREFERENCES');
  await assert.rejects(lstat(join(f.dir,'tmp/build/macos/Vibe Improve.previous.app')),{code:'ENOENT'});
});
test('failed replacement restores the previous application',async()=>{
  const f=await fixture();await f.prepare('old');const target=await publishMacApp(f.dir,f.stage);
  await assert.rejects(publishMacApp(f.dir,f.stage),{code:'ENOENT'});
  assert.equal(await readFile(join(target,'version'),'utf8'),'old');
});
test('an interrupted replacement recovers the old bundle before the next publish',async()=>{
  const f=await fixture(),backup=join(f.dir,'tmp/build/macos/Vibe Improve.previous.app');await mkdir(backup);await writeFile(join(backup,'version'),'recovered');
  await assert.rejects(publishMacApp(f.dir,f.stage),{code:'ENOENT'});
  assert.equal(await readFile(join(f.dir,'output/Vibe Improve.app/version'),'utf8'),'recovered');
});
test('output and bundle links cannot redirect replacement outside the intended folder',async()=>{
  const f=await fixture(),outside=join(f.dir,'outside');await mkdir(outside);await symlink(outside,join(f.dir,'output'));await f.prepare('new');
  await assert.rejects(publishMacApp(f.dir,f.stage),/OUTPUT_PATH_INVALID/);
  await assert.rejects(lstat(join(outside,'Vibe Improve.app')),{code:'ENOENT'});
});


test('repeated binary updates preserve the complete work directory including paired credentials and installation identity',async()=>{
 const f=await fixture();await f.prepare('initial');await publishMacApp(f.dir,f.stage);
 const runtime=join(f.dir,'output/Vibe Improve Runtime');
 const contents=new Map([
  ['device.json','SYNTHETIC_STABLE_DEVICE'],['preferences.json','SYNTHETIC_SETTINGS'],
  ['auth/session.json','SYNTHETIC_ENCRYPTED_SESSION'],['auth/session.key','SYNTHETIC_32_BYTE_KEY_MATERIAL____'],
  ['projects/index.json','SYNTHETIC_PROJECT_INDEX'],['projects/draft.json','SYNTHETIC_DRAFT'],
  ['agents/choices.json','SYNTHETIC_PROJECT_CHOICES'],['logs/native.ndjson','SYNTHETIC_LOG']
 ]);
 for(const [name,bytes] of contents){const parts=name.split('/');if(parts.length>1)await mkdir(join(runtime,parts[0]),{recursive:true});else await mkdir(runtime,{recursive:true});await writeFile(join(runtime,name),bytes);}
 const identity=(await lstat(runtime)).ino;
 for(let version=1;version<=3;version++){
  await f.prepare('new-'+version);await publishMacApp(f.dir,f.stage);
  assert.equal((await lstat(runtime)).ino,identity);
  for(const [name,bytes] of contents)assert.equal(await readFile(join(runtime,name),'utf8'),bytes);
 }
});
