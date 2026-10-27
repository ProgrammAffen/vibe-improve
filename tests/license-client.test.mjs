import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {verifyLicenseCertificate} from '../packages/license/verify-certificate.mjs';

const now = Date.UTC(2026,9,18,12);
const iso = offset => new Date(now + offset).toISOString();
const {privateKey,publicKey} = generateKeyPairSync('ed25519');
const trust = {keyId:'test-key',issuer:'test-issuer',audience:'test-client',productId:'vibe-improve',publicKeySpki:publicKey.export({type:'spki',format:'der'}).toString('base64url')};
const expected = {userId:'user-a',deviceId:'device-a',bindingId:'binding-current',licenseId:'license-a',now};
const claims = {schemaVersion:1,keyId:trust.keyId,issuer:trust.issuer,audience:trust.audience,productId:trust.productId,userId:expected.userId,deviceId:expected.deviceId,bindingId:expected.bindingId,licenseId:expected.licenseId,features:['app.access'],issuedAt:iso(-1000),notBefore:iso(-1000),expiresAt:iso(86_400_000),leaseExpiresAt:iso(3_600_000),offlineUntil:iso(3_600_000)};
function certificate(overrides = {}, signingKey = privateKey) {
  const payload = Buffer.from(JSON.stringify({...claims,...overrides})).toString('base64url');
  return {algorithm:'Ed25519',keyId:trust.keyId,payload,signature:sign(null,Buffer.from(payload,'ascii'),signingKey).toString('base64url')};
}
const verify = (cert, expectedIdentity = expected, configuredTrust = trust) => verifyLicenseCertificate(cert,configuredTrust,expectedIdentity);
const rejects = promise => assert.rejects(promise, error => error instanceof Error && error.code === 'CERTIFICATE_INVALID' && error.message === 'CERTIFICATE_INVALID');

test('real Ed25519 certificate returns only authenticated claims with immutable features', async () => {
  const result = await verify(certificate());
  assert.deepEqual(result, claims);
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.features));
  assert.throws(()=>result.features.push('admin'), TypeError);
});

test('payload and signature alteration fail verification', async () => {
  const cert=certificate();
  await rejects(verify({...cert,payload:Buffer.from(JSON.stringify({...claims,features:['admin']})).toString('base64url')}));
  const bytes=Buffer.from(cert.signature,'base64url');bytes[0]^=1;
  await rejects(verify({...cert,signature:bytes.toString('base64url')}));
  await rejects(verify({...cert,algorithm:'RS256'}));
  await rejects(verify({...cert,keyId:'unknown-key'}));
  await rejects(verify(certificate({keyId:'unknown-key'})));
});

test('response supplied key cannot override configured trust', async () => {
  const attacker=generateKeyPairSync('ed25519');
  const cert=certificate({},attacker.privateKey);
  cert.publicKeySpki=attacker.publicKey.export({type:'spki',format:'der'}).toString('base64url');
  cert.trust={...trust,publicKeySpki:cert.publicKeySpki};
  await rejects(verify(cert));
});

test('signed claims must match product, account, installation, binding and license', async () => {
  for(const field of ['issuer','audience','productId','userId','deviceId','bindingId','licenseId']) await rejects(verify(certificate({[field]:'other'})));
  await rejects(verify(certificate(),{...expected,bindingId:'new-binding-after-revoke'}));
  await rejects(verify(certificate({schemaVersion:true})));
  await rejects(verify(certificate({schemaVersion:2})));
  await rejects(verify(certificate(),{...expected,userId:undefined}));
});

test('times must be canonical UTC and all signed validity bounds must hold', async () => {
  const invalidClaims = [
    {expiresAt:iso(0)},{leaseExpiresAt:iso(0)},{notBefore:iso(1)},{issuedAt:iso(120001)},
    {leaseExpiresAt:iso(86_400_001)},{offlineUntil:iso(3_599_999)},{offlineUntil:iso(86_400_001)},
    {issuedAt:iso(3600000)},{notBefore:'2026-02-30T00:00:00.000Z'},
    {expiresAt:'2026-10-19T12:00:00.000+00:00'},{expiresAt:'2026-10-19T12:00:00.000Z\n'},
    {expiresAt:NaN},{expiresAt:null},{expiresAt:'Infinity'},{offlineUntil:undefined},
  ];
  for(const value of invalidClaims) await rejects(verify(certificate(value)));
  await rejects(verify(certificate(),{...expected,now:NaN}));
  await rejects(verify(certificate(),{...expected,now:Infinity}));
  await verify(certificate({issuedAt:iso(120000),notBefore:iso(0)}));
  await verify(certificate({leaseExpiresAt:claims.expiresAt,offlineUntil:claims.expiresAt}));
});

test('features are bounded, unique and safe identifiers', async () => {
  for(const features of [[],['app.access','app.access'],[''],['app.access\n'],['Admin'],['../admin'],['a'.repeat(81)],[3],{},Array.from({length:65},(_,i)=>`feature.${i}`)]) await rejects(verify(certificate({features})));
  await verify(certificate({features:['app.access','learning:ai','notes_export']}));
});

test('malformed encodings, key material and certificate shapes fail closed', async () => {
  const cert=certificate();
  for(const value of [null,[],{},'certificate']) await rejects(verify(value));
  for(const payload of ['',cert.payload+'=',cert.payload+'\n','a','a'.repeat(16385)]) await rejects(verify({...cert,payload}));
  for(const signature of ['',cert.signature+'\n','AA']) await rejects(verify({...cert,signature}));
  await rejects(verify(cert,expected,{...trust,publicKeySpki:'AA'}));
  await rejects(verify(cert,expected,{...trust,keyId:undefined}));
  const malformed=Buffer.from([0xff]).toString('base64url');
  await rejects(verify({...cert,payload:malformed,signature:sign(null,Buffer.from(malformed,'ascii'),privateKey).toString('base64url')}));
});

test('even a valid signature cannot grant an offline lease longer than seven days',async()=>{
 const base={issuedAt:iso(0),notBefore:iso(0),expiresAt:iso(30*86400_000)};
 await verify(certificate({...base,leaseExpiresAt:iso(7*86400_000),offlineUntil:iso(7*86400_000)}));
 await rejects(verify(certificate({...base,leaseExpiresAt:iso(7*86400_000+1),offlineUntil:iso(7*86400_000+1)})));
});
