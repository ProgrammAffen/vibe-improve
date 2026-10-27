import * as diagnosticContract from '../cloud/functions/license-api/diagnostic-contract.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';

const source=await readFile(new URL('../apps/local-ui/src/logger.ts',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const key='vibe-improve.diagnostics.v1';
function fixture({saved,failRead=false,failWrite=false,failNative=false}={}) {
  const data=new Map(saved===undefined?[]:[[key,saved]]),native=[],listeners=new Map();
  let clock=Date.UTC(2026,9,18);
  class TestDate extends Date {constructor(...args){super(...(args.length?args:[clock]));}static now(){return clock;}}
  const module={exports:{}};
  const localStorage={
    getItem(name){if(failRead)throw new Error('private read failure');return data.get(name)??null;},
    setItem(name,value){if(failWrite)throw new Error('private quota failure');data.set(name,value);},
    removeItem(name){if(failWrite)throw new Error('private quota failure');data.delete(name);},
  };
  vm.runInNewContext(compiled,{
    require: name => {if (name.endsWith('diagnostic-contract.mjs')) return diagnosticContract; throw new Error('UNEXPECTED_IMPORT');},module,exports:module.exports,crypto:{randomUUID},Date:TestDate,localStorage,
    window:{vibeNative:{log(entry){if(failNative)throw new Error('private native failure');native.push(entry);}},addEventListener:(name,callback)=>listeners.set(name,callback)},
  },{filename:'logger.ts'});
  return {...module.exports,data,native,listeners,age:()=>clock+=125};
}

test('diagnostics accept only fixed schema fields and never stringify private values',()=>{
  const f=fixture();
  const privateValue='test@example.invalid password token VI1-private activationCode /Users/private https://secret.invalid';
  const entry=f.logEvent('operation.failed',{
    operation:'auth.login',level:'error',traceId:randomUUID(),durationMs:17.8,resultCode:'AUTH_REQUIRED',licenseStatus:'invalid',
    email:privateValue,userId:privateValue,deviceId:privateValue,password:privateValue,activationCode:privateValue,token:privateValue,message:privateValue,stack:privateValue,url:privateValue,body:{privateValue},
  });
  assert.equal(entry.durationMs,18);
  assert.equal(entry.resultCode,'AUTH_REQUIRED');
  assert.ok(!f.diagnostics.exportText().includes(privateValue));
  assert.deepEqual(Object.keys(entry).sort(),['schemaVersion','timestamp','level','event','sessionId','traceId','operation','durationMs','resultCode','licenseStatus'].sort());
  assert.equal(f.logEvent(privateValue),undefined);
  f.logEvent('cloud.failed',{traceId:privateValue,operation:privateValue,resultCode:privateValue,licenseStatus:privateValue});
  assert.ok(!f.diagnostics.exportText().includes(privateValue));
  assert.equal(f.diagnosticResultCode({code:privateValue,message:privateValue,stack:privateValue}),'UNKNOWN_ERROR');
  assert.equal(f.diagnosticResultCode({get code(){throw new Error(privateValue);}}),'UNKNOWN_ERROR');
  assert.doesNotThrow(()=>f.logEvent('app.started',{get level(){throw new Error(privateValue);}}));
  assert.equal(f.logEvent('app.started',{durationMs:Infinity}).durationMs,undefined);
  assert.equal(f.logEvent('app.started',{durationMs:-1}).durationMs,0);
  assert.equal(f.logEvent('app.started',{durationMs:Number.MAX_SAFE_INTEGER}).durationMs,86_400_000);
});

test('ring buffer persists only the most recent bounded sanitized entries',()=>{
  const f=fixture();
  for(let index=0;index<450;index++) f.logEvent('app.started',{durationMs:index});
  const entries=f.diagnostics.getEntries();
  assert.equal(entries.length,300);
  assert.equal(entries[0].durationMs,150);
  assert.equal(entries.at(-1).durationMs,449);
  const persisted=f.data.get(key);
  assert.ok(Buffer.byteLength(persisted)<=f.LOG_LIMITS.bytes);
  const restored=fixture({saved:persisted});
  assert.equal(restored.diagnostics.getEntries().length,300);
  entries[0].resultCode='tampered';
  assert.equal(f.diagnostics.getEntries()[0].resultCode,undefined);
  f.diagnostics.clear();assert.equal(f.diagnostics.getEntries().length,0);assert.equal(f.data.has(key),false);
});

test('persistent input is sanitized and damaged/oversized storage safely resets',()=>{
  const f=fixture();const valid=f.logEvent('app.started');
  const restored=fixture({saved:JSON.stringify([{...valid,email:'never-restore@example.invalid',resultCode:'token private secret'},null,{...valid,event:'private secret'}])});
  assert.equal(restored.diagnostics.getEntries().length,1);
  assert.ok(!restored.diagnostics.exportText().includes('never-restore'));
  assert.ok(!restored.diagnostics.exportText().includes('token private secret'));
  for(const saved of ['broken JSON',JSON.stringify({token:'secret'}),'x'.repeat(256*1024+1)]) assert.equal(fixture({saved}).diagnostics.getEntries().length,0);
});

test('storage and native bridge failures retain diagnostics in memory and never break operations',()=>{
  const f=fixture({failRead:true,failWrite:true,failNative:true});
  assert.doesNotThrow(()=>f.logEvent('app.started'));
  assert.equal(f.diagnostics.getEntries().length,1);
  assert.ok(f.diagnostics.exportText().includes('app.started'));
  assert.doesNotThrow(()=>f.diagnostics.clear());assert.equal(f.diagnostics.getEntries().length,0);
});

test('spans track duration once and global failures ignore original messages and URLs',()=>{
  const f=fixture();const span=f.diagnosticSpan('auth.login');f.age();
  span.fail({code:'invalid_credentials',message:'private password'});span.succeed();
  const entries=f.diagnostics.getEntries();
  assert.equal(entries.length,2);assert.equal(entries[0].traceId,entries[1].traceId);
  assert.equal(entries[1].durationMs,125);assert.equal(entries[1].resultCode,'INVALID_CREDENTIALS');
  f.installGlobalDiagnostics();f.installGlobalDiagnostics();
  assert.equal(f.listeners.size,2);
  f.listeners.get('error')({message:'private password',filename:'https://private.invalid',error:new Error('private password')});
  f.listeners.get('unhandledrejection')({reason:{token:'private password'}});
  assert.ok(!f.diagnostics.exportText().includes('private password'));assert.ok(!f.diagnostics.exportText().includes('private.invalid'));
  assert.equal(f.diagnostics.getEntries().filter(entry=>entry.event==='app.started').length,1);
  assert.equal(f.native.length,f.diagnostics.getEntries().length);
});
