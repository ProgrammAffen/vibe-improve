import * as trustedClock from '../packages/license/trusted-clock.mjs';
import * as diagnosticContract from '../cloud/functions/license-api/diagnostic-contract.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import ts from 'typescript';

const source = await readFile(new URL('../apps/local-ui/src/api.ts', import.meta.url),'utf8');
const compiled = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const loggerSource = await readFile(new URL('../apps/local-ui/src/logger.ts', import.meta.url),'utf8');
const loggerCompiled = ts.transpileModule(loggerSource,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const passwordSource = await readFile(new URL('../apps/local-ui/src/password-validation.ts', import.meta.url),'utf8');
const passwordModule = {exports:{}};
vm.runInNewContext(ts.transpileModule(passwordSource,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:passwordModule,exports:passwordModule.exports});
function deferred() {
  let resolve,reject;
  const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}
const turn = () => new Promise(resolve=>setImmediate(resolve));

function fixture() {
  const events=new Map(),timers=new Map(),local=new Map(),calls=[],requests=[];
  let clock=Date.UTC(2026,9,18), credentials=null,refreshGate=null,statusGate=null,signInGate=null,timerId=0;
  const user = id => ({id,email:`${id}@example.invalid`,user_metadata:{}});
  const session = id => ({user:user(id),session:{access_token:`test-${id}`,refresh_token:`test-refresh-${id}`}});
  const auth={
    async signInWithPassword({email}) {
      calls.push('signIn:start');
      if(signInGate) await signInGate.promise;
      credentials=email.split('@')[0];calls.push(`signIn:${credentials}`);
      return {data:session(credentials),error:null};
    },
    async getUser(){return {data:{user:credentials?user(credentials):null},error:null};},
    async refreshSession(){
      const id=credentials;calls.push('refresh:start');
      if(refreshGate) await refreshGate.promise;
      credentials=id;calls.push(`refresh:write:${id}`);
      return {data:session(id),error:null};
    },
    async signOut(){calls.push('signOut');credentials=null;return {data:{},error:null};},
  };
  const app={
    auth:()=>auth,
    async callFunction({data}) {
      requests.push(data);
      calls.push(`${data.action}:${credentials}`);
      if(data.action==='status') {
        if(statusGate) await statusGate.promise;
        return {result:{ok:true,data:{status:'unlicensed',entitlement:null,device:null}}};
      }
      if(data.action==='devices') return {result:{ok:true,data:{devices:[]}}};
      throw new Error('UNEXPECTED_ACTION');
    },
  };
  const module={exports:{}};
  class TestDate extends Date {static now(){return clock;}}
  const sandbox={
    module,exports:module.exports,
    require:name=>{
      if (name.endsWith('trusted-clock.mjs')) return trustedClock;
      if(name==='@cloudbase/js-sdk') return {default:{init:()=>app}};
      if(name.endsWith('public-license-key.json')) return {default:{}};
      if(name.endsWith('verify-certificate.mjs')) return {verifyLicenseCertificate:async()=>{throw new Error('UNEXPECTED_CERTIFICATE');}};
      if(name==='./logger') return logger;
      if(name==='./password-validation') return passwordModule.exports;
      if(name.endsWith('diagnostic-contract.mjs')) return diagnosticContract;
      throw new Error('UNEXPECTED_IMPORT');
    },
    window:{addEventListener:(name,callback)=>events.set(name,callback)},
    document:{documentElement:{lang:'en'},hidden:false,addEventListener:(name,callback)=>events.set(name,callback)},
    localStorage:{getItem:key=>local.get(key)??null,setItem:(key,value)=>local.set(key,value),removeItem:key=>local.delete(key)},
    crypto:{randomUUID},structuredClone,Date:TestDate,
    setTimeout:(callback,delay)=>{const id=++timerId;timers.set(id,{callback,delay});return id;},
    clearTimeout:id=>timers.delete(id),
  };
  const loggerModule={exports:{}};
  vm.runInNewContext(loggerCompiled,{...sandbox,module:loggerModule,exports:loggerModule.exports},{filename:'logger.ts'});
  const logger=loggerModule.exports;
  vm.runInNewContext(compiled,sandbox,{filename:'api.ts'});
  return {
    service:module.exports.default,calls,timers,requests,diagnostics:logger.diagnostics,
    credentials:()=>credentials,
    age:()=>{clock+=7*86400000+1;},
    online:()=>events.get('online')(),
    visible:()=>events.get('visibilitychange')(),
    deferRefresh:()=>refreshGate=deferred(),
    deferStatus:()=>statusGate=deferred(),
    deferSignIn:()=>signInGate=deferred(),
  };
}

test('logout waits for refresh credential write and remaining license reads', {timeout:2000}, async()=>{
  const f=fixture();await f.service.login('alice@example.invalid','test-password');
  const refresh=f.deferRefresh(),status=f.deferStatus();
  f.age();f.online();
  const logout=f.service.logout();
  assert.equal((await f.service.getSnapshot()).busy,true);
  assert.ok(!f.calls.includes('signOut'));
  refresh.resolve();await turn();
  assert.ok(f.calls.includes('refresh:write:alice'));
  assert.ok(!f.calls.includes('signOut'));
  status.resolve();await logout;
  assert.equal(f.credentials(),null);
  assert.equal((await f.service.getSnapshot()).user,null);
  assert.equal((await f.service.getSnapshot()).busy,false);
  assert.equal(f.calls.at(-1),'signOut');
});

test('API operation and cloud diagnostics use new traces and exclude account/request data', async()=>{
  const f=fixture();
  await f.service.login('private-person@example.invalid','private-password-123');
  await f.service.refreshLicense();
  assert.equal(new Set(f.requests.map(request=>request.clientTraceId)).size,f.requests.length);
  assert.ok(f.requests.every(request=>/^[0-9a-f-]{36}$/.test(request.clientTraceId)));
  const entries=f.diagnostics.getEntries();
  for(const request of f.requests) {
    assert.ok(entries.some(entry=>entry.event==='cloud.started'&&entry.traceId===request.clientTraceId));
    assert.ok(entries.some(entry=>entry.event==='cloud.completed'&&entry.traceId===request.clientTraceId));
  }
  assert.ok(entries.some(entry=>entry.operation==='auth.login'&&entry.event==='operation.completed'));
  const exported=f.diagnostics.exportText();
  for(const secret of ['private-person','example.invalid','private-password-123',f.requests[0].deviceId]) assert.ok(!exported.includes(secret));
  assert.ok(!exported.includes('requestId'));
});

test('diagnostic traces do not change activation idempotency and never retain activation fields', async()=>{
  const f=fixture();await f.service.login('alice@example.invalid','test-password');
  const code='VI1-'+ 'a'.repeat(64);
  await assert.rejects(f.service.activate(code));
  await assert.rejects(f.service.activate(code));
  const writes=f.requests.filter(request=>request.action==='activate');
  assert.equal(writes.length,2);
  assert.equal(writes[0].requestId,writes[1].requestId);
  assert.notEqual(writes[0].clientTraceId,writes[1].clientTraceId);
  assert.ok(!f.diagnostics.exportText().includes(code.toUpperCase()));
  assert.ok(f.diagnostics.getEntries().some(entry=>entry.event==='cloud.failed'&&entry.resultCode==='UNKNOWN_ERROR'));
});

test('account switch waits for old license job and preserves the new credentials', {timeout:2000}, async()=>{
  const f=fixture();await f.service.login('alice@example.invalid','test-password');
  const status=f.deferStatus();f.age();f.online();
  const switchAccount=f.service.login('bob@example.invalid','test-password');
  await turn();assert.ok(!f.calls.includes('signIn:bob'));
  status.resolve();await switchAccount;
  assert.equal(f.credentials(),'bob');
  assert.equal((await f.service.getSnapshot()).user.id,'bob');
  assert.ok(f.calls.lastIndexOf('devices:alice')<f.calls.indexOf('signIn:bob'));
  assert.equal(f.calls.at(-1),'devices:bob');
});

test('busy operation prevents newly triggered background refresh and rejects a second operation', {timeout:2000}, async()=>{
  const f=fixture();await f.service.login('alice@example.invalid','test-password');
  const signin=f.deferSignIn();f.age();
  const switchAccount=f.service.login('bob@example.invalid','test-password');
  f.online();f.visible();
  assert.ok(!f.calls.includes('refresh:start'));
  await assert.rejects(f.service.logout(),error=>error.message==='BUSY');
  signin.resolve();await switchAccount;
  assert.equal(f.credentials(),'bob');
  assert.ok(!f.calls.includes('refresh:start'));
});

test('failed background refresh cannot block logout or leave a stale error', {timeout:2000}, async()=>{
  const f=fixture();await f.service.login('alice@example.invalid','test-password');
  const refresh=f.deferRefresh();f.age();f.online();
  const logout=f.service.logout();
  refresh.reject(new Error('NETWORK_FAILURE'));await logout;await turn();
  const state=await f.service.getSnapshot();
  assert.equal(f.credentials(),null);assert.equal(state.user,null);
  assert.equal(state.busy,false);assert.equal(state.error,null);
  assert.equal(f.timers.size,0);
});

test('manual refresh owns its internal license job without waiting on itself', {timeout:2000}, async()=>{
  const f=fixture();await f.service.login('alice@example.invalid','test-password');
  f.age();await f.service.refreshLicense();
  assert.equal(f.calls.filter(value=>value==='refresh:start').length,1);
  assert.equal((await f.service.getSnapshot()).busy,false);
  assert.equal((await f.service.getSnapshot()).user.id,'alice');
});
