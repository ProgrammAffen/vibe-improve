import test from 'node:test';
import assert from 'node:assert/strict';
import {diagnoseError,sanitizeDetails,PROVIDER_CODES} from '../cloud/functions/license-api/diagnostic-contract.mjs';
import {createRequestDiagnostics} from '../cloud/functions/license-api/diagnostics.mjs';

test('authentication reasons distinguish login, email, OTP, blocked accounts and provider configuration',()=>{
 const cases={invalid_credentials:'INVALID_CREDENTIALS',invalid_username_or_password:'INVALID_CREDENTIALS',already_exists:'AUTH_EMAIL_EXISTS',invalid_email:'AUTH_EMAIL_INVALID',email_not_verified:'AUTH_EMAIL_UNVERIFIED',invalid_verification_code:'AUTH_CODE_INVALID',code_expired:'AUTH_CODE_EXPIRED',password_too_weak:'AUTH_PASSWORD_WEAK',user_blocked:'AUTH_USER_BLOCKED',user_not_found:'AUTH_USER_NOT_FOUND',login_type_disabled:'AUTH_PROVIDER_DISABLED',unauthorized_client:'AUTH_CLIENT_DISABLED',unimplemented:'AUTH_CHANNEL_UNCONFIGURED',captcha_required:'AUTH_CAPTCHA_REQUIRED',captcha_invalid:'AUTH_CAPTCHA_INVALID',two_factor_required:'AUTH_MFA_REQUIRED',resource_exhausted:'RATE_LIMITED',missing_required_param:'AUTH_PARAMETER_MISSING'};
 for(const [code,expected]of Object.entries(cases)){const d=diagnoseError({code,status:400,errorCode:4000,requestId:'e6008cf8-a322-48cc-a9e3-34f17a68ad07'},{stage:'auth.registration.verify',verification:true});assert.equal(d.resultCode,expected,code);assert.equal(d.providerCode,code);assert.equal(d.httpStatus,400);assert.equal(d.providerErrorNumber,4000);assert.ok(d.providerRequestId);}
 assert.equal(diagnoseError({code:'invalid_argument'},{verification:true}).resultCode,'AUTH_CODE_REJECTED');
 assert.equal(diagnoseError({code:'invalid_argument',message:'verification code expired for secret@example.invalid'},{verification:true}).resultCode,'AUTH_CODE_EXPIRED');
 assert.equal(diagnoseError({code:'permission_denied',message:'cors permission denied https://private.invalid'}).reason,'domain_denied');
 assert.equal(diagnoseError({code:'internal',message:'smtp is not set secret@example.invalid'}).reason,'channel_unconfigured');
});

test('network and infrastructure diagnostics preserve useful safe detail without body or exception text',()=>{
 const secret='private.person@example.invalid SECRET_PASSWORD SECRET_TOKEN /Users/private/file https://private.invalid';
 const cause={name:'TypeError',message:'Failed to fetch '+secret,stack:'TypeError: '+secret+'\n at fn (https://private.invalid/assets/index-ABC.js:123:45)',code:secret,status:503,response:{body:secret},token:secret};
 const d=diagnoseError(cause,{stage:'auth.password.signin'});assert.equal(d.resultCode,'NETWORK_UNREACHABLE');assert.equal(d.site,'client_bundle');assert.equal(d.line,123);assert.equal(d.column,45);assert.equal(d.retryable,true);assert.ok(!JSON.stringify(d).includes('private'));assert.ok(!JSON.stringify(d).includes('SECRET'));
 assert.equal(diagnoseError(cause,{offline:true}).resultCode,'NETWORK_OFFLINE');
 assert.equal(diagnoseError({name:'TimeoutError',message:secret}).resultCode,'NETWORK_TIMEOUT');
 assert.equal(diagnoseError({name:'AbortError'}).resultCode,'REQUEST_ABORTED');
 assert.equal(diagnoseError({code:'DATABASE_UNAVAILABLE'}).reason,'database_unavailable');
 assert.equal(diagnoseError({name:'ReferenceError',message:secret}).errorType,'ReferenceError');
 assert.doesNotThrow(()=>diagnoseError({get code(){throw Error(secret);},get message(){throw Error(secret);}}));
});

test('detail filter rejects injection, malicious IDs, invalid ranges and unknown metadata',()=>{
 const d=sanitizeDetails({stage:'secret stage',reason:'password',providerCode:'secret',providerRequestId:'private token',parentTraceId:'secret',serverTraceId:'secret',httpStatus:999,providerErrorNumber:'token',retryAfterSeconds:-1,errorType:'private name',site:'/Users/private',line:Infinity,column:0,message:'secret',retryable:'secret'});
 assert.deepEqual(d,{});
 for(const code of PROVIDER_CODES)assert.equal(diagnoseError({code}).providerCode,code);
});

test('server failed request correlates both traces and stage, recording safe provider reason',()=>{
 const lines=[];const id='9749be68-9784-482f-8d6d-7efbc72af76a';const server='dd6f4556-e988-48c6-9876-61491553d615';
 const d=createRequestDiagnostics({action:'activate',clientTraceId:id,activationCode:'PRIVATE_CODE'},{sink:line=>lines.push(line),uuid:()=>server,platformRequestId:'e6008cf8-a322-48cc-a9e3-34f17a68ad07'});
 const r=d.finish({ok:false,error:{code:'ACTIVATION_CODE_UNAVAILABLE'}},{stage:'cloud.repository',cause:{code:'ACTIVATION_CODE_UNAVAILABLE',message:'PRIVATE_CODE'}});
 const record=JSON.parse(lines[0]);assert.equal(record.clientTraceId,id);assert.equal(record.traceId,server);assert.equal(record.resultCode,'ACTIVATION_CODE_UNAVAILABLE');assert.equal(record.stage,'cloud.repository');assert.ok(record.providerRequestId);assert.ok(!lines[0].includes('PRIVATE_CODE'));assert.equal(r.traceId,server);
});

test('cloud log reader parses platform envelopes and re-filters private fields',async()=>{
 const {safeCloudRecords}=await import('../scripts/read-runtime-logs.mjs');const record={schemaVersion:1,timestamp:'2026-10-19T03:01:14.678Z',level:'warn',event:'license_request',traceId:'68e054b9-d7a3-47e7-92b2-b79c40e402fe',clientTraceId:'2ed9ba66-0472-4b67-96c8-d37ef5ad2770',action:'activate',resultCode:'ACTIVATION_CODE_UNAVAILABLE',durationMs:481,reason:'activation_not_found',providerRequestId:'587a86d9-cb69-11f1-ba0a-5254008bd148',email:'PRIVATE_EMAIL',activationCode:'PRIVATE_CODE',requestBody:{token:'PRIVATE_TOKEN'}};
 const parsed=safeCloudRecords({LogResults:{Results:[{Content:'2026-10-19 INFO '+JSON.stringify(record)},{Content:'PRIVATE_PLATFORM_TEXT'}]}});assert.equal(parsed.length,1);assert.equal(parsed[0].reason,'activation_not_found');assert.ok(parsed[0].providerRequestId);assert.ok(!JSON.stringify(parsed).includes('PRIVATE'));assert.deepEqual(safeCloudRecords({event:'license_request',traceId:'token'}),[]);
});

test('public configuration errors retain the distinct safe internal cause code',()=>{
 const lines=[];createRequestDiagnostics({action:'activate'},{sink:line=>lines.push(line)}).finish({ok:false,error:{code:'SERVICE_UNCONFIGURED'}},{stage:'cloud.signer',cause:{code:'SIGNING_KEY_INVALID',message:'PRIVATE_KEY_CONTENT'}});const record=JSON.parse(lines[0]);assert.equal(record.resultCode,'SERVICE_UNCONFIGURED');assert.equal(record.causeCode,'SIGNING_KEY_INVALID');assert.equal(record.stage,'cloud.signer');assert.ok(!lines[0].includes('PRIVATE_KEY_CONTENT'));
});

test('untrusted error codes with hostile coercion cannot break diagnostics',()=>{assert.doesNotThrow(()=>diagnoseError({code:{toString(){throw Error('PRIVATE');}},message:'PRIVATE'}));});
