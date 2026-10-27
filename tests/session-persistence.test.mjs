import * as trustedClock from '../packages/license/trusted-clock.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID,generateKeyPairSync,sign,webcrypto} from 'node:crypto';
import {verifyLicenseCertificate} from '../packages/license/verify-certificate.mjs';
import vm from 'node:vm';
import ts from 'typescript';
import * as contract from '../cloud/functions/license-api/diagnostic-contract.mjs';

const compile = async file => ts.transpileModule(await readFile(new URL(file,import.meta.url),'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const apiSource=await compile('../apps/local-ui/src/api.ts'), logSource=await compile('../apps/local-ui/src/logger.ts');
const policy={exports:{}};
vm.runInNewContext(await compile('../apps/local-ui/src/password-validation.ts'),{module:policy,exports:policy.exports});
const defer=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function vault() {
  return {record:null,writes:[],clears:0,writeGate:null,clearGate:null,failRead:false,failWrite:false,
    async read(){if(this.failRead)throw Error('PRIVATE_NATIVE_DETAIL');return structuredClone(this.record);},
    async write(record){if(this.failWrite)throw Error('PRIVATE_NATIVE_DETAIL');if(this.writeGate)await this.writeGate.promise;this.record=structuredClone(record);this.writes.push(structuredClone(record));},
    async clear(){if(this.clearGate)await this.clearGate.promise;this.record=null;this.clears++;}};
}
function fixture(store,{restoreError=null,restoreGate=null,refreshGate=null,withExpiry=false,initialAge=0,certificateTrust={},cloudAction=null,deviceId='synthetic-installation-123',missingRefreshUser=false}={}) {
  let logger,current=null,listener,sdkStorage,version=0,sdkHeaders,now=Date.UTC(2026,9,19)+initialAge,timerId=0;
  const events=new Map(),local=new Map(),timers=new Map(),calls={password:0,restore:0,refresh:0,identity:0,cloud:0};
  const user={id:'synthetic-alice',email:'synthetic@example.invalid',user_metadata:{name:'Synthetic Alice'}},instance=randomUUID();
  const session=()=>({access_token:`SYNTHETIC_ACCESS_${instance}_${++version}`,refresh_token:`SYNTHETIC_REFRESH_${instance}_${version}`,user,...(withExpiry?{expires_at:new Date(now+7_200_000).toISOString(),expires_in:7200,scope:'user'}:{})});
  const result=()=>{current=user;return {data:{user,session:session()},error:null};};
  const auth={
    signInWithPassword:async()=>{calls.password++;return result();},
    getUser:async()=>{calls.identity++;return {data:{user:current}};},
    setSession:async()=>{calls.restore++;if(restoreGate)await restoreGate.promise;if(restoreError)return {error:restoreError};const value=result();if(missingRefreshUser)value.data.user=null;return value;},
    refreshSession:async()=>{calls.refresh++;if(refreshGate)await refreshGate.promise;return result();},
    onAuthStateChange:callback=>{listener=callback;},
    signOut:async()=>{listener?.('TOKEN_REFRESHED',session());current=null;return {data:{}};},
    resetPasswordForEmail:async()=>({data:{updateUser:async()=>result()}}),
    reauthenticate:async()=>({data:{updateUser:async()=>result()}}),
  };
  class Clock extends Date {static now(){return now;}}
  const sandbox={Date:Clock,crypto:{randomUUID,subtle:webcrypto.subtle},TextEncoder,Uint8Array,structuredClone,setTimeout:(callback,delay)=>{const id=++timerId;timers.set(id,{callback,delay});return id;},clearTimeout:id=>timers.delete(id),navigator:{onLine:true},console:{info:()=>{}},
    localStorage:{getItem:key=>local.get(key)??null,setItem:(key,value)=>local.set(key,value)},
    window:{vibeNative:{deviceId,session:store},addEventListener:(name,fn)=>events.set(name,fn)},
    document:{hidden:false,documentElement:{lang:'en'},addEventListener:()=>{}},
    require:name=>{
      if (name.endsWith('trusted-clock.mjs')) return trustedClock;
      if(name==='./password-validation')return policy.exports;
      if(name==='./logger')return logger;
      if(name.endsWith('diagnostic-contract.mjs'))return contract;
      if(name==='@cloudbase/js-sdk')return {default:{init:()=>({auth:options=>{sdkStorage=options.storage;sdkHeaders=options.headers;return auth;},callFunction:async({data})=>{calls.cloud++;return {result:{ok:true,data:cloudAction?await cloudAction(data):data.action==='status'?{status:'unlicensed'}:{devices:[]}}};}})}};
      if(name.endsWith('.json'))return {default:certificateTrust};
      if(name.endsWith('verify-certificate.mjs'))return {verifyLicenseCertificate:(cert,trust,expected)=>verifyLicenseCertificate(cert,trust,{...expected,now})};
      throw Error('UNEXPECTED_IMPORT');
    }};
  const l={exports:{}};vm.runInNewContext(logSource,{...sandbox,module:l,exports:l.exports});logger=l.exports;
  const a={exports:{}};vm.runInNewContext(apiSource,{...sandbox,module:a,exports:a.exports});
  return {service:a.exports.default,calls,logger,local,timers,storage:()=>sdkStorage,headers:()=>sdkHeaders,close:()=>events.get('pagehide')(),advance:ms=>{now+=ms;},online:()=>events.get('online')(),emitRefresh:()=>listener?.('TOKEN_REFRESHED',session())};
}

test('app restart restores via CloudBase, rotates tokens and never saves password or identity',async()=>{
  const store=vault(),first=fixture(store);await first.service.whenReady();
  await first.service.login('synthetic@example.invalid','SYNTHETIC_PASSWORD_123');
  const keys=Object.keys(store.record).sort();assert.deepEqual(keys,['accessToken','envId','refreshToken','schemaVersion']);
  assert.ok(!JSON.stringify(store.record).includes('SYNTHETIC_PASSWORD'));
  const old=store.record.refreshToken;first.close();
  const next=fixture(store);await next.service.whenReady();
  const state=await next.service.getSnapshot();assert.equal(state.user.id,'synthetic-alice');assert.equal(state.license.status,'unlicensed');
  assert.equal(next.calls.password,0);assert.equal(next.calls.restore,1);assert.equal(state.restoring,false);
  assert.notEqual(store.record.refreshToken,old);
  assert.ok(store.writes.length>=2);
  for(const key of next.local.keys())assert.ok(!String(next.local.get(key)).includes('SYNTHETIC_REFRESH'));
  assert.ok(!next.logger.diagnostics.exportText().includes('SYNTHETIC_REFRESH'));
});

test('logout drains pending saves, clears runtime session files and rejects late SDK refresh events',async()=>{
  const store=vault(),f=fixture(store);await f.service.whenReady();await f.service.login('synthetic@example.invalid','SYNTHETIC_PASSWORD_123');
  const gate=store.writeGate=defer();f.emitRefresh();await turn();
  const logout=f.service.logout();await turn();assert.equal(store.clears,0);
  f.emitRefresh();gate.resolve();await logout;await turn();
  assert.equal(store.record,null);assert.equal((await f.service.getSnapshot()).user,null);
  const next=fixture(store);await next.service.whenReady();assert.equal(next.calls.restore,0);assert.equal((await next.service.getSnapshot()).user,null);
});

test('expired session is purged while transient offline restore preserves it for the next start',async()=>{
  const store=vault(),f=fixture(store);await f.service.whenReady();await f.service.login('synthetic@example.invalid','SYNTHETIC_PASSWORD_123');
  const offline=fixture(store,{restoreError:{name:'TypeError',message:'Failed to fetch'}});await offline.service.whenReady();
  assert.ok(store.record);assert.equal((await offline.service.getSnapshot()).user,null);
  const retry=fixture(store);await retry.service.whenReady();assert.ok((await retry.service.getSnapshot()).user);
  const invalid=fixture(store,{restoreError:{code:'invalid_grant'}});await invalid.service.whenReady();await assert.rejects(invalid.service.refreshLicense());
  assert.equal(store.record,null);assert.equal((await invalid.service.getSnapshot()).user,null);
});

test('restoration blocks conflicting auth and refreshes license only after identity verification',async()=>{
  const store=vault(),f=fixture(store);await f.service.whenReady();await f.service.login('synthetic@example.invalid','SYNTHETIC_PASSWORD_123');
  const gate=defer(),next=fixture(store,{restoreGate:gate});await turn();
  assert.equal((await next.service.getSnapshot()).restoring,true);
  await assert.rejects(next.service.login('synthetic@example.invalid','SYNTHETIC_PASSWORD_123'),/BUSY/);
  gate.resolve();await next.service.whenReady();assert.equal((await next.service.getSnapshot()).busy,false);
  next.advance(21*60_000);await next.service.refreshLicense();assert.equal(next.calls.refresh,1);
});

test('reset and change password both forget persisted session after success',async()=>{
  for(const mode of ['reset','change']){
    const store=vault(),f=fixture(store);await f.service.whenReady();await f.service.login('synthetic@example.invalid','SYNTHETIC_PASSWORD_123');
    if(mode==='reset'){await f.service.sendReset('synthetic@example.invalid');await f.service.resetPassword('123456','SyntheticNew123');}
    else{await f.service.sendChangePassword();await f.service.changePassword('SYNTHETIC_PASSWORD_123','SyntheticNew123','123456');}
    assert.equal(store.record,null);assert.equal((await f.service.getSnapshot()).user,null);
  }
});

test('runtime file failure fails closed and never falls back to browser storage',async()=>{
  const store=vault();store.failWrite=true;const f=fixture(store);await f.service.whenReady();
  await assert.rejects(f.service.login('synthetic@example.invalid','SYNTHETIC_PASSWORD_123'),/runtime folder/i);
  const state=await f.service.getSnapshot();assert.equal(state.user,null);assert.match(state.error,/runtime folder/i);assert.equal(store.record,null);
  const exported=f.logger.diagnostics.exportText();assert.ok(exported.includes('SESSION_STORAGE_UNAVAILABLE'));assert.ok(!exported.includes('PRIVATE_NATIVE_DETAIL'));
});

test('unexpired local session reopens with zero authentication, identity or license requests',async()=>{
  const store=vault(),first=fixture(store,{withExpiry:true});await first.service.whenReady();await first.service.login('synthetic@example.invalid','SYNTHETIC_PASSWORD_123');
  assert.equal(store.record.schemaVersion,2);assert.equal(store.record.sessionExpiresAt-store.record.validatedAt,7*86400_000);
  const original=structuredClone(store.record),writes=store.writes.length;first.close();
  const next=fixture(store,{withExpiry:true,initialAge:60_000});await next.service.whenReady();
  const state=await next.service.getSnapshot();assert.equal(state.user.id,'synthetic-alice');assert.equal(state.license.status,'unlicensed');
  for(const key of ['password','restore','refresh','identity','cloud'])assert.equal(next.calls[key],0,key);
  next.online();await turn();assert.equal(next.calls.cloud,0);assert.equal(next.calls.refresh,0);
  const seeded=JSON.parse(await next.storage().getItem('credentials_one-person-company-7dao3979fd72e'));
  assert.equal(seeded.access_token,original.accessToken);assert.equal(Date.parse(seeded.expires_at),original.accessExpiresAt);
  assert.equal(store.writes.length,writes);assert.deepEqual(store.record,original);
  const text=next.logger.diagnostics.exportText();for(const secret of [original.accessToken,original.refreshToken,original.user.email])assert.ok(!text.includes(secret));
});

test('expired access tokens stay idle locally and seven-day sessions renew silently instead of requiring a password',async()=>{
 const store=vault(),first=fixture(store,{withExpiry:true});await first.service.whenReady();await first.service.login('synthetic@example.invalid','SYNTHETIC_PASSWORD_123');const deadline=store.record.sessionExpiresAt;first.close();
 const idle=fixture(store,{withExpiry:true,initialAge:3*3600000});await idle.service.whenReady();assert.equal(idle.calls.restore,0);assert.equal(idle.calls.cloud,0);assert.equal(store.record.sessionExpiresAt,deadline);idle.close();
 const renewed=fixture(store,{withExpiry:true,initialAge:7*86400000+1});await renewed.service.whenReady();assert.ok((await renewed.service.getSnapshot()).user);assert.equal(renewed.calls.password,0);assert.equal(renewed.calls.restore,1);assert.equal(renewed.calls.cloud,1);assert.ok(store.record.sessionExpiresAt>deadline);renewed.close();
});

test('negative license status stays cached during the seven-day local window',async()=>{
  const store=vault(),first=fixture(store,{withExpiry:true});await first.service.whenReady();await first.service.login('synthetic@example.invalid','SYNTHETIC_PASSWORD_123');first.close();
  const next=fixture(store,{withExpiry:true,initialAge:6*60_000});await next.service.whenReady();
  assert.equal(next.calls.restore,0);assert.equal(next.calls.refresh,0);assert.equal(next.calls.identity,0);assert.equal(next.calls.cloud,0);next.close();
});

test('verified refresh events roll the local window forward and an explicit invalid refresh clears credentials',async()=>{
  const store=vault(),first=fixture(store,{withExpiry:true});await first.service.whenReady();await first.service.login('synthetic@example.invalid','SYNTHETIC_PASSWORD_123');
  const deadline=store.record.sessionExpiresAt;first.advance(3600_000);first.emitRefresh();await turn();await turn();
  assert.equal(store.record.sessionExpiresAt,deadline+3600000);first.close();
  const invalid=fixture(store,{withExpiry:true,initialAge:5*3600_000,restoreError:{code:'invalid_grant'}});await invalid.service.whenReady();await assert.rejects(invalid.service.refreshLicense());
  assert.equal(store.record,null);assert.equal((await invalid.service.getSnapshot()).user,null);
});

test('cached license grants access only after real signature and lease verification, without startup requests',async()=>{
  const {privateKey,publicKey}=generateKeyPairSync('ed25519');
  const trust={keyId:'synthetic-cache-key',issuer:'synthetic-issuer',audience:'synthetic-client',productId:'vibe-improve',publicKeySpki:publicKey.export({type:'spki',format:'der'}).toString('base64url')};
  const now=Date.UTC(2026,9,19),iso=offset=>new Date(now+offset).toISOString();
  const claims={schemaVersion:1,keyId:trust.keyId,issuer:trust.issuer,audience:trust.audience,productId:trust.productId,userId:'synthetic-alice',deviceId:'synthetic-installation-123',bindingId:'synthetic-binding',licenseId:'synthetic-license',features:['app.access'],issuedAt:iso(-1000),notBefore:iso(-1000),expiresAt:iso(86400_000),leaseExpiresAt:iso(3600_000),offlineUntil:iso(3600_000)};
  const payload=Buffer.from(JSON.stringify(claims)).toString('base64url');
  const cert={algorithm:'Ed25519',keyId:trust.keyId,payload,signature:sign(null,Buffer.from(payload,'ascii'),privateKey).toString('base64url')};
  const store=vault(),first=fixture(store,{withExpiry:true});await first.service.whenReady();await first.service.login('synthetic@example.invalid','SYNTHETIC_PASSWORD_123');first.close();
  store.record.licenseCache={checkedAt:now,status:'valid',certificate:cert,bindingId:claims.bindingId,licenseId:claims.licenseId,maxDevices:2};
  const next=fixture(store,{withExpiry:true,initialAge:60_000,certificateTrust:trust});await next.service.whenReady();
  assert.equal((await next.service.getSnapshot()).license.active,true);assert.equal(next.calls.cloud,0);assert.equal(next.calls.restore,0);next.close();
  const validRecord=structuredClone(store.record);
  const altered=structuredClone(store.record),signature=Buffer.from(cert.signature,'base64url');signature[0]^=1;altered.licenseCache.certificate.signature=signature.toString('base64url');store.record=altered;
  const tampered=fixture(store,{withExpiry:true,initialAge:60_000,certificateTrust:trust});await tampered.service.whenReady();
  assert.equal((await tampered.service.getSnapshot()).license.active,false);assert.equal(tampered.calls.cloud,1);
  store.record=validRecord;
  const revoking=fixture(store,{withExpiry:true,initialAge:60_000,certificateTrust:trust,cloudAction:async({action})=>{if(action==='revoke')return {};throw {name:'TypeError',message:'Failed to fetch'};}});
  await revoking.service.whenReady();assert.equal((await revoking.service.getSnapshot()).license.active,true);
  await revoking.service.revokeDevice('synthetic-installation-123');
  assert.equal(store.record.licenseCache.status,'device_revoked');assert.ok((await revoking.service.getSnapshot()).user);revoking.close();
  const afterRevoke=fixture(store,{withExpiry:true,initialAge:60_000,certificateTrust:trust});await afterRevoke.service.whenReady();
  assert.equal((await afterRevoke.service.getSnapshot()).license.status,'device_revoked');assert.equal(afterRevoke.calls.cloud,0);

});

test('logout waits for an expiration-triggered SDK refresh before clearing persistent and in-memory sessions',async()=>{
  const gate=defer(),store=vault(),f=fixture(store,{withExpiry:true,refreshGate:gate});await f.service.whenReady();await f.service.login('synthetic@example.invalid','SYNTHETIC_PASSWORD_123');
  f.advance(7*86400000-4*60000);const [id,timer]=[...f.timers].sort((a,b)=>a[1].delay-b[1].delay)[0];f.timers.delete(id);timer.callback();
  await turn();assert.equal(f.calls.refresh,1);
  const logout=f.service.logout();await turn();assert.equal(store.clears,0);
  gate.resolve();await logout;assert.equal(store.record,null);assert.equal((await f.service.getSnapshot()).user,null);
});

test('authentication device IDs are stable standard UUIDs across restart and distinct between installations',async()=>{
 const store=vault(),id='dev_'+('ab'.repeat(24)),a=fixture(store,{deviceId:id,withExpiry:true});await a.service.whenReady();await a.service.login('synthetic@example.invalid','SYNTHETIC_PASSWORD_123');
 const first=a.headers()['x-device-id'];assert.match(first,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);assert.equal(await a.storage().getItem('device_id'),first);a.close();
 const b=fixture(store,{deviceId:id,withExpiry:true});await b.service.whenReady();assert.equal(b.headers()['x-device-id'],first);assert.equal(await b.storage().getItem('device_id'),first);b.close();
 const c=fixture(vault(),{deviceId:'dev_'+('cd'.repeat(24))});await c.service.whenReady();assert.notEqual(c.headers()['x-device-id'],first);c.close();
});
test('a cold SDK refresh with no cached user profile fetches identity before accepting the renewed session',async()=>{
 const store=vault(),a=fixture(store,{withExpiry:true});await a.service.whenReady();await a.service.login('synthetic@example.invalid','SYNTHETIC_PASSWORD_123');const deadline=store.record.sessionExpiresAt;a.close();
 const b=fixture(store,{withExpiry:true,initialAge:8*86400000,missingRefreshUser:true});await b.service.whenReady();assert.ok((await b.service.getSnapshot()).user);assert.equal(b.calls.password,0);assert.equal(b.calls.restore,1);assert.equal(b.calls.identity,1);assert.ok(store.record.sessionExpiresAt>deadline);b.close();
});


test('license validation failure during sign-in does not discard an otherwise valid account session',async()=>{
 const store=vault(),f=fixture(store,{withExpiry:true,cloudAction:async()=>{throw {code:'CERTIFICATE_INVALID'};}});
 await f.service.whenReady();await f.service.login('synthetic@example.invalid','SyntheticPassword123');
 assert.ok((await f.service.getSnapshot()).user);assert.equal((await f.service.getSnapshot()).license.active,false);assert.ok(store.record);assert.equal(store.clears,0);f.close();
});
