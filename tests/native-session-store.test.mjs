import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile,stat,chmod,symlink,link,rm,readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url)),base=join(root,'tmp/checks/native-session-store');
const env={...process.env,CLANG_MODULE_CACHE_PATH:join(root,'tmp/cache/clang'),SWIFT_MODULECACHE_PATH:join(root,'tmp/cache/swift')};
const valid={schemaVersion:1,envId:'one-person-company-7dao3979fd72e',accessToken:'SYNTHETIC_ACCESS',refreshToken:'SYNTHETIC_REFRESH'};
const aad=Buffer.from('vibe-improve.session.v1:one-person-company-7dao3979fd72e');
const options={skip:process.platform!=='darwin',timeout:60_000};
let compiled;
async function binary() {
  if(!compiled)compiled=(async()=>{
    await mkdir(base,{recursive:true});const dir=await mkdtemp(join(base,'build-')),main=join(dir,'main.swift'),executable=join(dir,'session-test');
    await writeFile(main,`import Foundation
let mode = CommandLine.arguments[1]
let url = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
let store = SessionCredentialStore(runtimeRoot: url)
let valid: [String: Any] = ["schemaVersion": 1, "envId": "one-person-company-7dao3979fd72e", "accessToken": "SYNTHETIC_ACCESS", "refreshToken": "SYNTHETIC_REFRESH"]
do {
    if mode == "write" { try store.write(valid) }
    if mode == "read" {
        if let value = try store.read() { precondition(value["refreshToken"] as? String == "SYNTHETIC_REFRESH"); print("PRESENT") }
        else { print("EMPTY") }
    }
    if mode == "clear" { try store.clear() }
    if mode == "lock" {
        try RuntimeDirectory(url: url).child("auth").locked {
            do { _ = try store.read(); preconditionFailure("ignored lock contention") }
            catch { print("LOCKED") }
        }
    }
    if mode == "input" { try store.write(JSONSerialization.jsonObject(with: Data(contentsOf: url.appendingPathComponent("input.json")))) }
    if mode == "migrate" { try RuntimeDirectory(url: url).migratePreferences(from: url.deletingLastPathComponent().appendingPathComponent("legacy")) }
    print("OK")
} catch {
    print((error as? SessionStoreError) == .invalid || (error as? RuntimeFileError) == .invalid ? "INVALID" : "UNAVAILABLE")
    exit(3)
}
`);
    const compile=spawnSync('/usr/bin/swiftc',['-module-cache-path',join(root,'tmp/cache/swift'),join(root,'apps/macos/RuntimeDirectory.swift'),join(root,'apps/macos/SessionCredentialStore.swift'),main,'-o',executable],{cwd:root,env,encoding:'utf8'});
    assert.equal(compile.status,0,compile.stderr);return executable;
  })();
  return compiled;
}
async function fixture() {
  const executable=await binary(),dir=await mkdtemp(join(base,'run-')),runtime=join(dir,'Vibe Improve Runtime');
  const run=(mode,{failure=false}={})=>{
    const result=spawnSync(executable,[mode,runtime],{cwd:root,env,encoding:'utf8'});
    assert.equal(result.status,failure?3:0,result.stderr+result.stdout);return result.stdout;
  };
  return {dir,runtime,auth:join(runtime,'auth'),run};
}

test('runtime files survive process restart, are encrypted, rotate nonces and clear both credentials',options,async()=>{
  const f=await fixture();assert.match(f.run('read'),/EMPTY/);f.run('write');
  const first=await readFile(join(f.auth,'session.json'),'utf8'),key=await readFile(join(f.auth,'session.key'));
  assert.ok(!first.includes('SYNTHETIC'));assert.equal(key.length,32);
  const envelope=JSON.parse(first);assert.deepEqual(Object.keys(envelope).sort(),['algorithm','payload','schemaVersion']);
  const bytes=Buffer.from(envelope.payload,'base64'),decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));
  decipher.setAAD(aad);decipher.setAuthTag(bytes.subarray(-16));
  assert.deepEqual(JSON.parse(Buffer.concat([decipher.update(bytes.subarray(12,-16)),decipher.final()])),valid);
  assert.match(f.run('read'),/PRESENT/);f.run('write');assert.notEqual(await readFile(join(f.auth,'session.json'),'utf8'),first);
  for(const path of [f.runtime,f.auth])assert.equal((await stat(path)).mode&0o777,0o700);
  for(const name of ['session.key','session.json','session.lock'])assert.equal((await stat(join(f.auth,name))).mode&0o777,0o600);
  assert.ok(!(await readdir(f.auth)).some(n=>n.startsWith('.write-')));
  f.run('clear');assert.match(f.run('read'),/EMPTY/);
  for(const name of ['session.key','session.json'])await assert.rejects(stat(join(f.auth,name)),{code:'ENOENT'});
});

test('portable AES-GCM envelope interoperates and rejects altered, malformed and oversized data',options,async()=>{
  const f=await fixture();f.run('read');
  const key=randomBytes(32),nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(aad);
  const bytes=Buffer.concat([nonce,cipher.update(JSON.stringify(valid)),cipher.final(),cipher.getAuthTag()]);
  const encode=payload=>JSON.stringify({schemaVersion:1,algorithm:'AES-256-GCM',payload:payload.toString('base64')});
  await writeFile(join(f.auth,'session.key'),key,{mode:0o600});await writeFile(join(f.auth,'session.json'),encode(bytes),{mode:0o600});
  assert.match(f.run('read'),/PRESENT/);
  const altered=Buffer.from(bytes);altered[15]^=1;
  for(const content of [encode(altered),'not-json','x'.repeat(60001),JSON.stringify({schemaVersion:true,algorithm:'AES-256-GCM',payload:bytes.toString('base64')})]){
    await writeFile(join(f.auth,'session.json'),content);assert.match(f.run('read',{failure:true}),/INVALID/);
  }
  await writeFile(join(f.auth,'session.json'),encode(bytes));await rm(join(f.auth,'session.key'));assert.match(f.run('read',{failure:true}),/INVALID/);
  f.run('clear');f.run('write');assert.match(f.run('read'),/PRESENT/);
});

test('runtime bridge payload rejects extra identity fields, invalid tokens and foreign environments',options,async()=>{
  const f=await fixture();f.run('write');const original=await readFile(join(f.auth,'session.json'),'utf8');
  const inputs=[...['password','email','userId','arbitrary'].map(key=>({...valid,[key]:'PRIVATE'})),
    ...[true,1.5,2,'1'].map(schemaVersion=>({...valid,schemaVersion})),{...valid,envId:'foreign'},
    ...['short','with space','with\nnewline','a'.repeat(16385)].map(refreshToken=>({...valid,refreshToken}))];
  for(const input of inputs){await writeFile(join(f.runtime,'input.json'),JSON.stringify(input),{mode:0o600});assert.match(f.run('input',{failure:true}),/INVALID/);}
  assert.equal(await readFile(join(f.auth,'session.json'),'utf8'),original);assert.match(f.run('read'),/PRESENT/);
});

test('runtime storage refuses directory links, file links and lock contention without touching their targets',options,async()=>{
  for(const name of ['session.json','session.key','session.lock']){
    const f=await fixture();f.run('write');
    const target=join(f.dir,'outside.txt');await writeFile(target,'UNCHANGED',{mode:0o644});
    await rm(join(f.auth,name));await symlink(target,join(f.auth,name));
    f.run('read',{failure:true});f.run('write',{failure:true});f.run('clear',{failure:true});
    assert.equal(await readFile(target,'utf8'),'UNCHANGED');assert.equal((await stat(target)).mode&0o777,0o644);
  }
  const f=await fixture();f.run('write');assert.match(f.run('lock'),/LOCKED/);
  const target=join(f.dir,'outside.txt');await writeFile(target,'UNCHANGED',{mode:0o644});
  await rm(join(f.auth,'session.json'));await link(target,join(f.auth,'session.json'));f.run('write',{failure:true});f.run('clear',{failure:true});
  assert.equal(await readFile(target,'utf8'),'UNCHANGED');await rm(join(f.auth,'session.json'));
  await rm(f.auth,{recursive:true});await symlink(f.dir,f.auth);f.run('read',{failure:true});f.run('write',{failure:true});
  await rm(f.auth);await rm(f.runtime,{recursive:true});await symlink(f.dir,f.runtime);f.run('read',{failure:true});
});

test('preference migration preserves installation ID, keeps legacy recovery and never overwrites new state',options,async()=>{
  const f=await fixture(),legacy=join(f.dir,'legacy');await mkdir(legacy);
  const saved=JSON.stringify({deviceId:'dev_synthetic_installation',preferences:{language:'en'}});
  await writeFile(join(legacy,'preferences.json'),saved,{mode:0o600});f.run('migrate');
  assert.equal(await readFile(join(f.runtime,'preferences.json'),'utf8'),saved);
  assert.equal(await readFile(join(legacy,'preferences.json'),'utf8'),saved);
  const next=JSON.stringify({deviceId:'dev_synthetic_installation',preferences:{language:'zh-CN'}});
  await writeFile(join(f.runtime,'preferences.json'),next);f.run('migrate');
  assert.equal(await readFile(join(f.runtime,'preferences.json'),'utf8'),next);
  await chmod(join(f.runtime,'preferences.json'),0o644);f.run('migrate');assert.equal((await stat(join(f.runtime,'preferences.json'))).mode&0o777,0o600);
});

test('versioned expiry and display cache round trips while malformed timestamps and extra fields are refused',options,async()=>{
  const f=await fixture();f.run('read');
  const now=Date.UTC(2026,9,19),value={...valid,schemaVersion:2,validatedAt:now,accessExpiresAt:now+7200_000,sessionExpiresAt:now+7*86400_000,user:{id:'synthetic-alice',email:'synthetic@example.invalid',nickname:'Synthetic'},scope:'user',licenseCache:{checkedAt:now,status:'unlicensed',certificate:null,bindingId:'',licenseId:'',maxDevices:0}};
  await writeFile(join(f.runtime,'input.json'),JSON.stringify(value),{mode:0o600});f.run('input');assert.match(f.run('read'),/PRESENT/);
  for(const change of [{validatedAt:true},{sessionExpiresAt:now+8*86400_000},{user:{...value.user,password:'PRIVATE'}},{licenseCache:{...value.licenseCache,status:'valid'}},{licenseCache:{...value.licenseCache,activationCode:'PRIVATE'}}]){
    await writeFile(join(f.runtime,'input.json'),JSON.stringify({...value,...change}));assert.match(f.run('input',{failure:true}),/INVALID/);
  }
  assert.match(f.run('read'),/PRESENT/);
});

test('encrypted license lease tokens and resumable renewals are whitelisted and strictly bounded',options,async()=>{
  const f=await fixture();f.run('read');
  const now=Date.UTC(2026,9,20),renewal={requestId:'311974c8-3261-46a5-9fc4-e42cbca3005a',renewalId:'renew_'+'a'.repeat(32),nextLeaseToken:'b'.repeat(64),startedAt:now,retryCount:2,nextRetryAt:now+60000};
  const cache={checkedAt:now,status:'device_limit',certificate:null,bindingId:'',licenseId:'synthetic-license',maxDevices:2,leaseToken:'c'.repeat(64),renewal};
  const value={...valid,schemaVersion:2,validatedAt:now,accessExpiresAt:now+7200_000,sessionExpiresAt:now+7*86400_000,user:{id:'synthetic-alice',email:'synthetic@example.invalid',nickname:'Synthetic'},scope:'user',licenseCache:cache};
  await writeFile(join(f.runtime,'input.json'),JSON.stringify(value),{mode:0o600});f.run('input');assert.match(f.run('read'),/PRESENT/);
  const encrypted=await readFile(join(f.auth,'session.json'),'utf8');
  for(const secret of [cache.leaseToken,renewal.nextLeaseToken,renewal.renewalId])assert.ok(!encrypted.includes(secret));
  for(const changed of [{leaseToken:'PRIVATE'}, {renewal:{...renewal,retryCount:6}}, {renewal:{...renewal,nextLeaseToken:'not-a-token'}}, {renewal:{...renewal,requestId:'not-a-uuid'}}, {renewal:{...renewal,arbitrary:'PRIVATE'}}, {renewal:{...renewal,startedAt:true}}]){
    await writeFile(join(f.runtime,'input.json'),JSON.stringify({...value,licenseCache:{...cache,...changed}}));assert.match(f.run('input',{failure:true}),/INVALID/);
  }
  assert.match(f.run('read'),/PRESENT/);
});

test('local device list snapshots are encrypted, account scoped and retain cloud-configured capacity',options,async()=>{
  const f=await fixture();f.run('read');
  const now=Date.UTC(2026,9,20),device={deviceId:'dev_synthetic_current_0123456789',bindingId:'synthetic-binding-012345',deviceName:'Synthetic Private Mac',lastSeenAt:'2026-10-20T00:00:00.000Z'};
  const list={checkedAt:now,userId:'synthetic-alice',licenseId:'synthetic-license',maxDevices:5,devices:[device]};
  const cache={checkedAt:now,status:'device_limit',certificate:null,bindingId:'',licenseId:'synthetic-license',maxDevices:5,leaseToken:'',renewal:null,deviceList:list};
  const value={...valid,schemaVersion:2,validatedAt:now,accessExpiresAt:now+7200_000,sessionExpiresAt:now+7*86400_000,user:{id:'synthetic-alice',email:'synthetic@example.invalid',nickname:'Synthetic'},scope:'user',licenseCache:cache};
  await writeFile(join(f.runtime,'input.json'),JSON.stringify(value),{mode:0o600});f.run('input');assert.match(f.run('read'),/PRESENT/);
  const encrypted=await readFile(join(f.auth,'session.json'),'utf8');
  for(const secret of [device.deviceId,device.bindingId,device.deviceName])assert.ok(!encrypted.includes(secret));
  for(const changed of [{userId:'another-user'},{licenseId:'another-license'},{maxDevices:101},{checkedAt:true},{devices:[device,device]},{devices:[{...device,leaseToken:'PRIVATE'}]}]){
    await writeFile(join(f.runtime,'input.json'),JSON.stringify({...value,licenseCache:{...cache,deviceList:{...list,...changed}}}));assert.match(f.run('input',{failure:true}),/INVALID/);
  }
  assert.match(f.run('read'),/PRESENT/);
});

test('encrypted trusted clock anchor round trips and rejects extra fields, booleans and invalid bounds',options,async()=>{
 const f=await fixture();f.run('read');const now=Date.UTC(2026,9,20),clock={schemaVersion:1,bootId:'synthetic_boot_0123456789',continuousMs:100,serverTimeMs:now};
 const value={...valid,schemaVersion:2,validatedAt:now,accessExpiresAt:now+7200_000,sessionExpiresAt:now+7*86400_000,user:{id:'synthetic-alice',email:'synthetic@example.invalid',nickname:'Synthetic'},scope:'user',licenseCache:null,licenseClock:clock};
 for(const licenseClock of [clock,null]){await writeFile(join(f.runtime,'input.json'),JSON.stringify({...value,licenseClock}));f.run('input');assert.match(f.run('read'),/PRESENT/);}
 for(const changed of [{schemaVersion:true},{schemaVersion:2},{continuousMs:true},{continuousMs:-1},{serverTimeMs:0},{bootId:'short'},{extra:'PRIVATE'}]){await writeFile(join(f.runtime,'input.json'),JSON.stringify({...value,licenseClock:{...clock,...changed}}));assert.match(f.run('input',{failure:true}),/INVALID/);}
 const invalid={...value,unrecognized:null};delete invalid.licenseClock;await writeFile(join(f.runtime,'input.json'),JSON.stringify(invalid));assert.match(f.run('input',{failure:true}),/INVALID/);
});

test('bounded network recovery metadata is encrypted, compatible with old v2 records and strictly validated',options,async()=>{
 const f=await fixture();f.run('read');const now=Date.UTC(2026,9,20),networkRetry={attempts:2,nextRetryAt:now+300000,refreshDevices:true};
 const value={...valid,schemaVersion:2,validatedAt:now,accessExpiresAt:now+7200_000,sessionExpiresAt:now+7*86400_000,user:{id:'synthetic-alice',email:'synthetic@example.invalid',nickname:'Synthetic'},scope:'user',licenseCache:null};
 for(const record of [value,{...value,networkRetry},{...value,licenseClock:null,networkRetry}]){await writeFile(join(f.runtime,'input.json'),JSON.stringify(record));f.run('input');assert.match(f.run('read'),/PRESENT/);}
 assert.ok(!(await readFile(join(f.auth,'session.json'),'utf8')).includes('networkRetry'));
 for(const change of [{attempts:4},{attempts:-1},{attempts:true},{nextRetryAt:0},{nextRetryAt:1.5},{refreshDevices:1},{extra:'PRIVATE'}]){await writeFile(join(f.runtime,'input.json'),JSON.stringify({...value,networkRetry:{...networkRetry,...change}}));assert.match(f.run('input',{failure:true}),/INVALID/);}
});
