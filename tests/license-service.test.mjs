import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createLicenseService, createSigner, verifyCertificate, COLLECTIONS, accountId, sha256 } from '../cloud/functions/license-api/service.mjs';
import { trustedIdentity, requestFromEvent } from '../cloud/functions/license-api/cloud-auth.mjs';
import { cloudRepository } from '../cloud/functions/license-api/cloud-repository.mjs';

class MemoryRepo {
  rows = new Map(); tail = Promise.resolve(); failCollection = null;
  transaction(fn) {
    const next = this.tail.then(async () => {
      const draft = structuredClone(this.rows);
      const result = await fn({
        get: async (c, id) => structuredClone(draft.get(`${c}/${id}`) ?? null),
        put: async (c, id, v) => { if (c === this.failCollection) throw new Error('injected storage failure'); draft.set(`${c}/${id}`, structuredClone(v)); },
      });
      this.rows = draft;
      return structuredClone(result);
    });
    this.tail = next.catch(() => {});
    return next;
  }
  seed(c, id, value) { this.rows.set(`${c}/${id}`, structuredClone(value)); }
  get(c, id) { return this.rows.get(`${c}/${id}`); }
}
const { privateKey } = generateKeyPairSync('ed25519');
const signer = createSigner({ privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }), keyId: 'test-ed25519-1', issuer: 'test-license', audience: 'test-client', productId: 'test-product' });
const identity = (uid = 'user-a') => ({ uid, anonymous: false });
const id = () => randomUUID();
function fixture({ maxDevices = 1, lifetime = 86_400_000, grace = 600, rate = 500 } = {}) {
  const repo = new MemoryRepo(); let time = Date.UTC(2026, 9, 18);
  const code = `VI1-${'A'.repeat(64)}`;
  const hash = sha256(code);
  repo.seed(COLLECTIONS.codes, hash, { codeHash: hash, productId: signer.productId, status: 'available', maxDevices, features: ['learning.ai'], expiresAt: new Date(time + lifetime).toISOString() });
  const service = createLicenseService({ repo, signer, maxDevices, leaseSeconds: 3600, offlineGraceSeconds: grace, rateLimitPerMinute: rate, now: () => time });
  const call = (request, who = identity()) => service.handle(request, who);
  const activate = (who = identity()) => call({ action: 'activate', requestId: id(), activationCode: code, deviceId: 'device-0000000000001', deviceName: 'Test device', appVersion: '1.0.0' }, who);
  const bind = (deviceId = 'device-0000000000001', who = identity()) => call({ action: 'bind', requestId: id(), deviceId, deviceName: 'Test device', appVersion: '1.0.0' }, who);
  return { repo, code, hash, call, activate, bind, advance: n => { time += n; } };
}
const rejectsCode = (promise, code) => assert.rejects(promise, e => e.code === code);

test('CloudBase event metadata is excluded while unknown business fields stay rejected', async () => {
  const f = fixture();
  const event = {action:'status',tcbContext:{TCB_UUID:'forged-user',TCB_ISANONYMOUS_USER:'false'}};
  const request = requestFromEvent(event);
  assert.deepEqual(request, {action:'status'});
  assert.equal((await f.call(request)).status, 'unlicensed');
  assert.ok(event.tcbContext);
  await rejectsCode(f.call(requestFromEvent({...event,userId:'forged-user'})), 'INVALID_REQUEST');
  await rejectsCode(f.call(request, {uid:'forged-user',anonymous:true}), 'AUTH_REQUIRED');
  for (const invalid of [null, [], 'status']) await rejectsCode(f.call(requestFromEvent(invalid)), 'INVALID_REQUEST');
});

test('two accounts cannot claim one activation code', async () => {
  const f = fixture();
  const outcomes = await Promise.allSettled([f.activate(identity('alice')), f.activate(identity('bob'))]);
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(x => x.status === 'rejected').reason.code, 'ACTIVATION_CODE_UNAVAILABLE');
  assert.equal(f.repo.get(COLLECTIONS.codes, f.hash).status, 'claimed');
  assert.equal([...f.repo.rows.keys()].filter(x => x.startsWith(`${COLLECTIONS.accounts}/`)).length, 1);
  assert.ok(!JSON.stringify([...f.repo.rows]).includes(f.code));
});

test('activation rollback leaves code and account untouched', async () => {
  const f = fixture(); f.repo.failCollection = COLLECTIONS.receipts;
  await assert.rejects(f.activate(), /storage failure/);
  assert.equal(f.repo.get(COLLECTIONS.codes, f.hash).status, 'available');
  assert.equal(f.repo.get(COLLECTIONS.accounts, accountId(signer.productId, 'user-a')), undefined);
});

test('concurrent binds cannot oversubscribe one seat', async () => {
  const f = fixture(); await f.activate();
  const result = await Promise.allSettled([f.bind('device-0000000000001'), f.bind('device-0000000000002')]);
  assert.equal(result.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(result.find(x => x.status === 'rejected').reason.code, 'DEVICE_LIMIT_REACHED');
  assert.equal((await f.call({ action: 'devices' })).devices.length, 1);
});

test('bind receipt and renewal receipt are stable; changed request rejected', async () => {
  const f = fixture(); await f.activate();
  const request = { action: 'bind', requestId: id(), deviceId: 'device-0000000000001', deviceName: 'Test', appVersion: '1' };
  const first = await f.call(request); f.advance(30_000);
  assert.deepEqual(await f.call(request), first);
  await rejectsCode(f.call({ ...request, deviceName: 'Other' }), 'IDEMPOTENCY_KEY_REUSED');
  const renewal = { action: 'renew', requestId: id(), deviceId: request.deviceId, bindingId: first.device.bindingId, leaseToken: first.leaseToken, renewalId: `renew_${'1'.repeat(32)}`, nextLeaseToken: 'b'.repeat(64) };
  const renewed = await f.call(renewal); f.advance(45_000);
  assert.deepEqual(await f.call(renewal), renewed);
  assert.notEqual(renewed.certificate.payload, first.certificate.payload);
});

test('revoke frees seat and blocks renewal and old receipt after rebind', async () => {
  const f = fixture(); await f.activate();
  const request = { action: 'bind', requestId: id(), deviceId: 'device-0000000000001', deviceName: 'Test', appVersion: '1' };
  const bound = await f.call(request);
  const renew = { action: 'renew', requestId: id(), deviceId: request.deviceId, bindingId: bound.device.bindingId, leaseToken: bound.leaseToken, renewalId: `renew_${'2'.repeat(32)}`, nextLeaseToken: 'c'.repeat(64) };
  await f.call(renew);
  const revoke = { action: 'revoke', requestId: id(), deviceId: request.deviceId };
  const result = await f.call(revoke);
  assert.deepEqual(await f.call(revoke), result);
  await rejectsCode(f.call(renew), 'DEVICE_REVOKED');
  await rejectsCode(f.call(request), 'DEVICE_REVOKED');
  assert.equal((await f.call({ action: 'devices' })).devices.length, 0);
  const rebound = await f.bind(request.deviceId);
  assert.notEqual(rebound.device.bindingId, bound.device.bindingId);
  await rejectsCode(f.call(renew), 'DEVICE_REVOKED');
});

test('caller cannot select another user or operate another account device', async () => {
  const f = fixture(); await f.activate(); await f.bind();
  await rejectsCode(f.call({ action: 'devices', userId: 'user-a' }, identity('user-b')), 'INVALID_REQUEST');
  const other = await f.call({ action: 'devices' }, identity('user-b'));
  assert.equal(other.entitlement, null); assert.deepEqual(other.devices, []);
  await rejectsCode(f.call({ action: 'revoke', requestId: id(), deviceId: 'device-0000000000001' }, identity('user-b')), 'LICENSE_REQUIRED');
  for (const invalid of [null, {}, { uid: 'user-a' }, { uid: 'user-a', anonymous: true }]) await rejectsCode(f.call({ action: 'status' }, invalid), 'AUTH_REQUIRED');
});

test('signed claims include all identities and no time exceeds entitlement', async () => {
  const f = fixture({ lifetime: 1_800_000 }); await f.activate(); const result = await f.bind();
  const claims = verifyCertificate(result.certificate, signer.publicKeyPem);
  assert.equal(claims.userId, 'user-a'); assert.equal(claims.deviceId, result.device.deviceId);
  assert.equal(claims.licenseId, result.entitlement.licenseId); assert.equal(claims.productId, signer.productId);
  assert.equal(claims.leaseExpiresAt, claims.expiresAt); assert.equal(claims.offlineUntil, claims.expiresAt);
  const tampered = { ...result.certificate, payload: Buffer.from(JSON.stringify({ ...claims, features: ['admin'] })).toString('base64url') };
  assert.equal(verifyCertificate(tampered, signer.publicKeyPem), null);
  assert.equal(verifyCertificate({ ...result.certificate, keyId: 'wrong' }, signer.publicKeyPem), null);
});

test('expired entitlement cannot bind/renew but device management remains', async () => {
  const f = fixture({ lifetime: 5_000 }); await f.activate(); const b = await f.bind(); f.advance(5_000);
  assert.equal((await f.call({ action: 'status' })).status, 'expired');
  await rejectsCode(f.bind('device-0000000000002'), 'LICENSE_EXPIRED');
  await rejectsCode(f.call({ action: 'renew', requestId: id(), deviceId: b.device.deviceId, bindingId: b.device.bindingId }), 'LICENSE_EXPIRED');
  assert.equal((await f.call({ action: 'devices' })).devices.length, 1);
  assert.equal((await f.call({ action: 'revoke', requestId: id(), deviceId: b.device.deviceId })).revoked, true);
});

test('expired code cannot grant; another legacy grant preserves the current license', async () => {
  const expired = fixture({ lifetime: 1 }); expired.advance(1); await rejectsCode(expired.activate(), 'GRANT_EXPIRED');
  const f = fixture(); await f.activate();
  const code = `VI1-${'B'.repeat(64)}`; const hash = sha256(code);
  const record = { ...f.repo.get(COLLECTIONS.codes, f.hash), codeHash: hash, status: 'available' };
  delete record.claimedBy; delete record.claimedAt; delete record.licenseId;
  f.repo.seed(COLLECTIONS.codes, hash, record);
  const before = (await f.call({ action: 'status' })).entitlement;
  const renewed = await f.call({ action: 'activate', requestId: id(), activationCode: code, deviceId: 'device-0000000000001', deviceName: 'Test', appVersion: '1' });
  assert.equal(renewed.entitlement.licenseId, before.licenseId);
  assert.equal(renewed.entitlement.expiresAt, before.expiresAt);
  assert.equal(f.repo.get(COLLECTIONS.codes, hash).status, 'claimed');
});

test('rate limit persists across rejected activation attempts', async () => {
  const f = fixture({ rate: 2 });
  for (let n = 0; n < 2; n++) await rejectsCode(f.call({ action: 'activate', requestId: id(), activationCode: `VI1-${'F'.repeat(64)}`, deviceId: 'device-0000000000001', deviceName: 'Test', appVersion: '1' }), 'ACTIVATION_CODE_UNAVAILABLE');
  await rejectsCode(f.call({ action: 'status' }), 'RATE_LIMITED');
  f.advance(60_000); assert.equal((await f.call({ action: 'status' })).status, 'unlicensed');
});

test('auth only uses platform context; missing or anonymous flags fail closed', async () => {
  const trustedContext = { environment: '{"platform":"trusted"}' };
  let received;
  const app = { auth: () => ({ getAuthContext: async c => { received = c; return { uid: 'real-user', loginType: 'platform-type' }; } }) };
  const sdk = { getCloudbaseContext: c => { assert.equal(c, trustedContext); return { TCB_ISANONYMOUS_USER: 'false' }; } };
  assert.deepEqual(await trustedIdentity(app, sdk, trustedContext), { uid: 'real-user', anonymous: false });
  assert.equal(received, trustedContext);
  await rejectsCode(trustedIdentity(app, { getCloudbaseContext: () => ({}) }, trustedContext), 'AUTH_CONTEXT_UNSUPPORTED');
  await rejectsCode(trustedIdentity(app, { getCloudbaseContext: () => ({ TCB_ISANONYMOUS_USER: 'true' }) }, trustedContext, ['platform-type']), 'AUTH_REQUIRED');
  assert.equal((await trustedIdentity(app, { getCloudbaseContext: () => ({}) }, trustedContext, ['platform-type'])).uid, 'real-user');
});

test('CloudBase transaction adapter accepts verified get result and propagates failures', async () => {
  const records = new Map();
  const db = { runTransaction: fn => fn({ collection: () => ({ doc: id => ({ get: async () => ({ data: records.get(id) ? [records.get(id)] : [] }), set: async data => { records.set(id, data); return { updated: 1 }; } }) }) }) };
  const repo = cloudRepository(db);
  await repo.transaction(async tx => { assert.equal(await tx.get('x', 'missing'), null); await tx.put('x', 'a', { _id: 'a', value: 1 }); assert.deepEqual(await tx.get('x', 'a'), { value: 1 }); });
  await assert.rejects(repo.transaction(async () => { throw new Error('transaction failure'); }), /transaction failure/);
});

test('activation diagnostics distinguish missing, used, wrong-product and corrupt codes without changing public errors',async()=>{
 const scenarios=[['activation_not_found',null],['activation_used',{status:'claimed'}],['activation_wrong_product',{productId:'other-product'}],['activation_record_invalid',{codeHash:'corrupt'}]];
 for(const [reason,patch]of scenarios){const f=fixture();if(patch===null)f.repo.rows.delete(`${COLLECTIONS.codes}/${f.hash}`);else f.repo.seed(COLLECTIONS.codes,f.hash,{...f.repo.get(COLLECTIONS.codes,f.hash),...patch});await assert.rejects(f.activate(),e=>e.code==='ACTIVATION_CODE_UNAVAILABLE'&&e.diagnosticReason===reason);}
});
