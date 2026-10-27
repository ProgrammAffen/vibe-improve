import * as trustedClock from '../packages/license/trusted-clock.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import * as contract from '../cloud/functions/license-api/diagnostic-contract.mjs';

const compile = async file => ts.transpileModule(await readFile(new URL(file, import.meta.url), 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const apiSource = await compile('../apps/local-ui/src/api.ts');
const logSource = await compile('../apps/local-ui/src/logger.ts');
const passwordModule = {exports:{}};
vm.runInNewContext(await compile('../apps/local-ui/src/password-validation.ts'), {module:passwordModule,exports:passwordModule.exports});
const {passwordValid, passwordPair} = passwordModule.exports;

function fixture() {
  let now = Date.UTC(2026,9,19), logger, resetResponse, resetCalls = 0;
  const updates = [], store = new Map();
  const auth = {
    async resetPasswordForEmail() {
      const id = ++resetCalls;
      if (resetResponse) return resetResponse();
      return {data:{updateUser:async value => {updates.push({id,...value}); return {data:{}};}}};
    },
    async signUp() {return {data:{verifyOtp:async()=>({data:{}})}};},
    async signOut() {return {data:{}};},
  };
  class Clock extends Date {static now() {return now;}}
  const sandbox = {Date:Clock,crypto:{randomUUID},structuredClone,setTimeout,clearTimeout,navigator:{onLine:true},console:{info:()=>{}},
    localStorage:{getItem:key=>store.get(key)??null,setItem:(key,value)=>store.set(key,value)},
    window:{addEventListener:()=>{}},document:{hidden:false,documentElement:{lang:'en'},addEventListener:()=>{}},
    require:name => {
      if (name.endsWith('trusted-clock.mjs')) return trustedClock;
      if (name === './password-validation') return passwordModule.exports;
      if (name === './logger') return logger;
      if (name.endsWith('diagnostic-contract.mjs')) return contract;
      if (name === '@cloudbase/js-sdk') return {default:{init:()=>({auth:()=>auth})}};
      if (name.endsWith('.json')) return {default:{}};
      if (name.endsWith('verify-certificate.mjs')) return {};
      throw new Error('UNEXPECTED_IMPORT');
    }};
  const l={exports:{}};
  vm.runInNewContext(logSource,{...sandbox,module:l,exports:l.exports});logger=l.exports;
  const a={exports:{}};
  vm.runInNewContext(apiSource,{...sandbox,module:a,exports:a.exports});
  return {service:a.exports.default,logger,updates,calls:()=>resetCalls,now:()=>now,advance:ms=>{now+=ms;},respond:fn=>{resetResponse=fn;}};
}

test('password pair reports mismatch before a code is entered and clears after correction', () => {
  assert.equal(passwordPair('ValidTest123','Different123').mismatch,true);
  assert.equal(passwordPair('ValidTest123','Different123').valid,false);
  assert.equal(passwordPair('ValidTest123','ValidTest123').mismatch,false);
  assert.equal(passwordPair('ValidTest123','ValidTest123').valid,true);
  assert.equal(passwordPair('','').valid,false);
  for (const value of ['short1','lettersOnly','123456789','A1'+ 'x'.repeat(127)]) assert.equal(passwordValid(value),false);
  assert.equal(passwordValid('A1'+'x'.repeat(126)),true);
});

test('reset sends once, blocks only until its deadline, then uses the new verification closure', async () => {
  const f=fixture(),email='synthetic@example.invalid';
  await f.service.sendReset(email);
  assert.equal(f.calls(),1);
  assert.equal(f.service.getCodeRetryAt('reset',email),f.now()+60_000);
  await assert.rejects(f.service.sendReset(email),/Wait before requesting another code/);
  assert.equal(f.calls(),1);
  const failure=f.logger.diagnostics.getEntries().find(v=>v.resultCode==='RESEND_TOO_SOON');
  assert.equal(failure.retryAfterSeconds,60);
  f.advance(60_000);
  await f.service.sendReset(email);
  await f.service.resetPassword('123456','ValidTest123');
  assert.equal(f.calls(),2);
  assert.equal(f.updates[0].id,2);
});

test('other email and verification purposes do not inherit an unrelated local cooldown', async () => {
  const f=fixture();
  await f.service.sendRegistration('synthetic@example.invalid','ValidTest123','Test');
  await f.service.sendReset('synthetic@example.invalid');
  await f.service.sendReset('other@example.invalid');
  assert.equal(f.calls(),2);
  assert.equal(f.service.getCodeRetryAt('reset',' SYNTHETIC@EXAMPLE.INVALID '),f.now()+60_000);
});

test('provider rate limit exposes its retry delay and makes no early duplicate request', async () => {
  const f=fixture(),email='synthetic@example.invalid';
  f.respond(async()=>({error:{code:'resource_exhausted',status:429,retryAfter:120}}));
  await assert.rejects(f.service.sendReset(email));
  assert.equal(f.service.getCodeRetryAt('reset',email),f.now()+120_000);
  f.advance(119_000);
  await assert.rejects(f.service.sendReset(email));
  assert.equal(f.calls(),1);
  f.advance(1000);f.respond(null);
  await f.service.sendReset(email);
  assert.equal(f.calls(),2);
});

test('failed request does not start a success cooldown or discard the existing code challenge', async () => {
  const f=fixture(),email='synthetic@example.invalid';
  f.respond(async()=>{throw new TypeError('Failed to fetch');});
  await assert.rejects(f.service.sendReset(email));
  assert.equal(f.service.getCodeRetryAt('reset',email),0);
  f.respond(null);await f.service.sendReset(email);f.advance(60_000);
  f.respond(async()=>{throw new TypeError('Failed to fetch');});
  await assert.rejects(f.service.sendReset(email));
  await f.service.resetPassword('123456','ValidTest123');
  assert.equal(f.updates[0].id,2);
});

test('missing update callback fails without pretending a usable code was sent', async () => {
  const f=fixture(),email='synthetic@example.invalid';
  f.respond(async()=>({data:{}}));
  await assert.rejects(f.service.sendReset(email),/Send an email code first/);
  assert.equal(f.service.getCodeRetryAt('reset',email),0);
  await assert.rejects(f.service.resetPassword('123456','ValidTest123'));
  assert.equal(f.updates.length,0);
});
