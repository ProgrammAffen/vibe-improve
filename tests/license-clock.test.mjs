import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {TrustedLicenseClock,validClockAnchor} from '../packages/license/trusted-clock.mjs';
import {verifyServerTimeProof} from '../packages/license/verify-certificate.mjs';
const day=86400_000,epoch=Date.UTC(2026,9,20),boot='synthetic_boot_0123456789';
function fixture(){let continuousMs=100,perf=0,bootId=boot;return {clock:new TrustedLicenseClock({sample:async()=>({schemaVersion:1,bootId,continuousMs}),performanceNow:()=>perf}),advance:ms=>{continuousMs+=ms;perf+=ms;},sleep:ms=>{continuousMs+=ms;},boot:id=>{bootId=id;continuousMs=0;perf=0;}};}
test('trusted time counts sleep, closed App time and performance elapsed independently of system date',async()=>{
 const f=fixture(),before=await f.clock.sample();await f.clock.observe(epoch,before);f.advance(1000);assert.equal(f.clock.now(),epoch+1000);
 f.sleep(7*day);await f.clock.sample();assert.equal(f.clock.now(),epoch+1000+7*day);
 const record=f.clock.record();f.advance(1000);const restored=new TrustedLicenseClock({sample:()=>f.clock.sample(),performanceNow:()=>0});assert.equal(await restored.restore(record),true);assert.equal(restored.now(),epoch+2000+7*day);
});
test('native boot change, counter rollback and malformed anchors cannot restore offline time',async()=>{
 const f=fixture();await f.clock.observe(epoch,await f.clock.sample());const record=f.clock.record();f.boot('synthetic_boot_9876543210');assert.equal(await f.clock.restore(record),false);assert.throws(()=>f.clock.now(),{code:'LICENSE_CLOCK_UNTRUSTED'});
 for(const changed of [{continuousMs:NaN},{serverTimeMs:true},{bootId:'short'},{schemaVersion:2},{extra:'value'}])assert.equal(validClockAnchor({...record,...changed}),false);
 const g=fixture();assert.equal(await g.clock.restore({...record,continuousMs:1000}),false);
});
test('delayed or out-of-order signed responses cannot move trusted time backward or extend an old deadline',async()=>{
 const f=fixture(),old=await f.clock.sample();f.advance(1000);await f.clock.observe(epoch+1000,await f.clock.sample());const floor=f.clock.now();
 f.advance(1000);await f.clock.observe(epoch-10*day,old);assert.ok(f.clock.now()>=floor+1000);
 const g=fixture(),before=await g.clock.sample();g.advance(10000);await g.clock.observe(epoch,before);assert.equal(g.clock.now(),epoch+10000);
});
test('clock sampling failure and performance counter rollback fail closed',async()=>{
 let failed=false,perf=5;const c=new TrustedLicenseClock({sample:async()=>{if(failed)throw Error();return {schemaVersion:1,bootId:boot,continuousMs:100};},performanceNow:()=>perf});
 await c.observe(epoch,await c.sample());perf=4;assert.throws(()=>c.now(),{code:'LICENSE_CLOCK_UNTRUSTED'});failed=true;await assert.rejects(c.sample(),{code:'LICENSE_CLOCK_UNTRUSTED'});assert.equal(c.trusted,false);
});
const {privateKey,publicKey}=generateKeyPairSync('ed25519');
const trust={keyId:'synthetic-clock-key',issuer:'synthetic',audience:'synthetic-app',productId:'vibe-improve',publicKeySpki:publicKey.export({type:'spki',format:'der'}).toString('base64url')};
const expected={userId:'synthetic-user',nonce:'311974c8-3261-46a5-9fc4-e42cbca3005a'};
function proof(change={}){const payload=Buffer.from(JSON.stringify({schemaVersion:1,keyId:trust.keyId,issuer:trust.issuer,audience:trust.audience,productId:trust.productId,purpose:'server-time-v1',...expected,serverTime:new Date(epoch).toISOString(),...change})).toString('base64url');return {algorithm:'Ed25519',keyId:trust.keyId,payload,signature:sign(null,Buffer.from(payload),privateKey).toString('base64url')};}
test('server time proof is pinned to a signing key, account, product, purpose and fresh per-request nonce',async()=>{
 assert.equal(await verifyServerTimeProof(proof(),trust,expected),epoch);
 for(const change of [{userId:'other-user'},{nonce:'old-request'},{productId:'other-product'},{purpose:'license'},{serverTime:'not-a-date'},{issuer:'other-issuer'}])await assert.rejects(verifyServerTimeProof(proof(change),trust,expected),{code:'CERTIFICATE_INVALID'});
 await assert.rejects(verifyServerTimeProof({...proof(),signature:'a'.repeat(86)},trust,expected),{code:'CERTIFICATE_INVALID'});
 await assert.rejects(verifyServerTimeProof(proof(),{...trust,keyId:'wrong'},expected),{code:'CERTIFICATE_INVALID'});
});
