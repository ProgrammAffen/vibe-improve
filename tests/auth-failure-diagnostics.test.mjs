import * as trustedClock from '../packages/license/trusted-clock.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import {randomUUID} from 'node:crypto';
import * as contract from '../cloud/functions/license-api/diagnostic-contract.mjs';
const compile=async path=>ts.transpileModule(await readFile(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const api=await compile('../apps/local-ui/src/api.ts'),log=await compile('../apps/local-ui/src/logger.ts');
const passwordModule={exports:{}};
vm.runInNewContext(await compile('../apps/local-ui/src/password-validation.ts'),{module:passwordModule,exports:passwordModule.exports});
function fixture(error,method){
 let logger;const callbacks=new Map(),store=new Map();const emitted=[];
 const auth={signInWithPassword:async()=>({error}),signUp:async()=>({error}),getUser:async()=>({data:{user:{id:'synthetic',email:'private@example.invalid'}}})};
 const sandbox={crypto:{randomUUID},structuredClone,Date,setTimeout,clearTimeout,navigator:{onLine:true},console:{info:x=>emitted.push(x)},window:{addEventListener:(n,f)=>callbacks.set(n,f)},document:{hidden:false,documentElement:{lang:'en'},addEventListener:()=>{}},localStorage:{getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v)},require:n=>n.endsWith('trusted-clock.mjs')?trustedClock:n.endsWith('diagnostic-contract.mjs')?contract:n==='./password-validation'?passwordModule.exports:n==='./logger'?logger:n==='@cloudbase/js-sdk'?{default:{init:()=>({auth:()=>auth})}}:n.endsWith('.json')?{default:{}}:{verifyLicenseCertificate:()=>{}}};
 const l={exports:{}};vm.runInNewContext(log,{...sandbox,module:l,exports:l.exports});logger=l.exports;
 const a={exports:{}};vm.runInNewContext(api,{...sandbox,module:a,exports:a.exports});return {service:a.exports.default,logger,emitted};
}
test('real API module records registration and login provider failures with safe detail and linked operation traces',async()=>{
 for(const [method,error,stage,expected]of [
 ['login',{code:'invalid_credentials',status:400,errorCode:4010,requestId:randomUUID()},'auth.password.signin','INVALID_CREDENTIALS'],
 ['registration',{code:'already_exists',status:409,errorCode:4004,requestId:randomUUID()},'auth.registration.send','AUTH_EMAIL_EXISTS'],
 ['registration',{code:'invalid_verification_code',status:400,errorCode:4015,requestId:randomUUID()},'auth.registration.send','AUTH_CODE_INVALID'],
 ['registration',{code:'unimplemented',status:500,errorCode:12,requestId:randomUUID()},'auth.registration.send','AUTH_CHANNEL_UNCONFIGURED'],
 ['login',{code:'permission_denied',status:403,message:'cors permission denied https://private.invalid'},'auth.password.signin','AUTH_DOMAIN_DENIED'],
 ]){
 const f=fixture(error,method);await assert.rejects(method==='login'?f.service.login('private@example.invalid','private-password-123'):f.service.sendRegistration('private@example.invalid','private-password-123','Private Person'));
 const events=f.logger.diagnostics.getEntries();const failure=events.find(e=>e.event==='operation.failed'&&e.stage===stage);assert.equal(failure.resultCode,expected);assert.equal(failure.providerCode,error.code);assert.equal(failure.httpStatus,error.status);assert.ok(failure.parentTraceId);assert.ok(events.some(e=>e.traceId===failure.parentTraceId));
 const text=f.logger.diagnostics.exportText();for(const word of ['private@example','private-password','Private Person','private.invalid'])assert.ok(!text.includes(word));assert.ok(f.emitted.some(line=>line.startsWith('VI_DIAGNOSTIC ')));
 }
});
