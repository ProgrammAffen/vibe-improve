import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { constants, encodeActivationCode, normalizeActivationCode, verifyActivationCode } from '../cloud/functions/license-api/activation-code-v2.mjs';
import { accountId, COLLECTIONS, createLicenseService, createSigner, deviceDocId, sha256, slotDocId, verifyCertificate } from '../cloud/functions/license-api/service.mjs';

class MemoryRepo {
  rows = new Map(); tail = Promise.resolve(); failCollection = null;
  transaction(callback) {
    const operation = this.tail.then(async () => {
      const draft = structuredClone(this.rows);
      const result = await callback({
        get: async (collection, id) => structuredClone(draft.get(`${collection}/${id}`) ?? null),
        put: async (collection, id, value) => {
          if (this.failCollection === collection) throw new Error('synthetic storage failure');
          draft.set(`${collection}/${id}`, structuredClone(value));
        },
      });
      this.rows = draft; return structuredClone(result);
    });
    this.tail = operation.catch(() => {}); return operation;
  }
  get(collection, id) { return this.rows.get(`${collection}/${id}`); }
  seed(collection, id, value) { this.rows.set(`${collection}/${id}`, structuredClone(value)); }
}
function keyPair() {
  const keys = generateKeyPairSync('ed25519');
  return { privateKeyPem: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }) };
}
const activationKeys = keyPair();
const certificateKeys = keyPair();
const signer = createSigner({ ...certificateKeys, keyId: 'test-signing-v1', issuer: 'vibe-improve-test', audience: 'test-client', productId: 'vibe-improve' });
const uid = 'synthetic-owner';
const identity = id => ({ uid: id, anonymous: false });
const deviceId = n => `synthetic-device-${String(n).padStart(16, '0')}`;
const rejected = (promise, code) => assert.rejects(promise, error => error.code === code);
function fixture({ maxDevices = 2, leaseSeconds = 168 * 3600 } = {}) {
  let at = Date.UTC(2026, 9, 20, 6);
  const repo = new MemoryRepo();
  const options = { repo, signer, activationCodePublicKeyPem: activationKeys.publicKeyPem, maxDevices, leaseSeconds, now: () => at, rateLimitPerMinute: 1000 };
  const service = createLicenseService(options);
  const call = (request, owner = uid, selectedService = service) => selectedService.handle(request, identity(owner));
  const code = (durationDays = 30) => encodeActivationCode({ durationDays, issuedAt: at }, activationKeys.privateKeyPem);
  const activate = (activationCode = code(), n = 1, owner = uid) => call({ action: 'activate', requestId: randomUUID(), activationCode, deviceId: deviceId(n), deviceName: `Synthetic ${n}`, appVersion: 'test' }, owner);
  const bind = (n = 1) => call({ action: 'bind', requestId: randomUUID(), deviceId: deviceId(n), deviceName: `Synthetic ${n}`, appVersion: 'test' });
  const renew = (bound, token = 'a'.repeat(64)) => ({ action: 'renew', requestId: randomUUID(), deviceId: bound.device.deviceId, bindingId: bound.device.bindingId, leaseToken: bound.leaseToken, renewalId: `renew_${randomUUID().replaceAll('-', '')}`, nextLeaseToken: token });
  return { repo, options, service, call, code, activate, bind, renew, time: () => at, advance: delta => { at += delta; } };
}

function signedAdversarialCode({ domain = constants.domain, header = constants.header, durationDays = 10, issuedAt = Date.UTC(2026, 9, 20) } = {}) {
  const payload = Buffer.alloc(13); payload[0] = header; payload.writeUInt16BE(durationDays, 1);
  payload.writeUInt16BE(Math.floor((issuedAt - constants.epoch) / constants.dayMs), 3);
  const signature = sign(null, Buffer.concat([Buffer.from(domain), payload]), activationKeys.privateKeyPem);
  let value = BigInt(`0x${Buffer.concat([payload, signature]).toString('hex')}`), text = '';
  while (value) { text = constants.alphabet[Number(value % 31n)] + text; value /= 31n; }
  return `VI-${text.match(/.{1,4}/g).join('-')}`;
}

test('v2 compact issuer uses 31-character alphabet, 77-byte signed frame and profile 1', () => {
  const at = Date.UTC(2026, 9, 20), nonce = Buffer.from('0011223344556677', 'hex');
  const code = encodeActivationCode({ durationDays: 365, issuedAt: at, nonce }, activationKeys.privateKeyPem);
  assert.equal(constants.alphabet.length, 31); assert.equal(code.length, 157); assert.ok(code.startsWith('VI-'));
  const decoded = verifyActivationCode(code.toLowerCase().replaceAll('-', ' \n '), activationKeys.publicKeyPem, at);
  assert.equal(decoded.durationDays, 365); assert.equal(decoded.nonce, nonce.toString('hex'));
  assert.equal(decoded.profileId, 1); assert.deepEqual(decoded.features, ['app.access']); assert.equal(decoded.tier, 'pro');
  assert.equal(decoded.codeHash, sha256(normalizeActivationCode(code)));
  assert.equal(normalizeActivationCode(code.slice(3)), normalizeActivationCode(code));
});

test('v2 rejects foreign domains, profiles, signatures, future dates and bad verification configuration', () => {
  const at = Date.UTC(2026, 9, 20);
  for (const code of [signedAdversarialCode({ domain: 'vibe-learning:activation:v2\0' }), signedAdversarialCode({ header: 0x22 }),
    signedAdversarialCode({ durationDays: 0 }), signedAdversarialCode({ issuedAt: at + 2 * constants.dayMs })]) {
    assert.throws(() => verifyActivationCode(code, activationKeys.publicKeyPem, at), error => error.code === 'INVALID_ACTIVATION_CODE');
  }
  const code = encodeActivationCode({ durationDays: 7, issuedAt: at }, activationKeys.privateKeyPem);
  assert.throws(() => verifyActivationCode(code, keyPair().publicKeyPem, at), error => error.code === 'INVALID_ACTIVATION_CODE');
  assert.throws(() => verifyActivationCode(code, 'not-a-public-key', at), error => error.code === 'SERVICE_UNCONFIGURED');
  assert.throws(() => encodeActivationCode({ durationDays: 65536 }, activationKeys.privateKeyPem));
});

test('activation atomically grants, binds a fixed slot and signs the entire seven-day lease', async () => {
  const f = fixture(), code = f.code(), result = await f.activate(code);
  assert.equal(result.entitlement.maxDevices, 2); assert.equal(result.maxDevices, 2); assert.equal(result.leaseDurationHours, 168);
  assert.match(result.leaseToken, /^[a-f0-9]{64}$/); assert.equal(result.device.slotIndex, 0);
  assert.equal(Date.parse(result.leaseExpiresAt), f.time() + 7 * constants.dayMs);
  const claims = verifyCertificate(result.certificate, signer.publicKeyPem);
  assert.equal(claims.leaseExpiresAt, result.leaseExpiresAt); assert.equal(claims.offlineUntil, result.leaseExpiresAt);
  assert.equal(claims.deviceId, deviceId(1)); assert.equal(claims.userId, uid); assert.equal(claims.bindingId, result.device.bindingId);
  assert.equal(f.repo.get(COLLECTIONS.devices, slotDocId(signer.productId, uid, result.entitlement.licenseId, 0)).deviceId, deviceId(1));
  const persisted = JSON.stringify([...f.repo.rows]);
  assert.ok(!persisted.includes(code)); assert.ok(!persisted.includes(result.leaseToken));
  assert.equal(f.repo.get(COLLECTIONS.codes, sha256(normalizeActivationCode(code))).firstDeviceId, deviceId(1));
});

test('same signed activation code cannot be redeemed concurrently by two accounts', async () => {
  const f = fixture(), code = f.code();
  const results = await Promise.allSettled([f.activate(code, 1, 'owner-a'), f.activate(code, 2, 'owner-b')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'ACTIVATION_CODE_UNAVAILABLE');
  assert.equal([...f.repo.rows.keys()].filter(k => k.startsWith(`${COLLECTIONS.accounts}/`)).length, 1);
});

test('activation storage failure rolls back grant, redemption, device and receipt together', async () => {
  const f = fixture(), code = f.code(); f.repo.failCollection = COLLECTIONS.receipts;
  await assert.rejects(f.activate(code), /synthetic storage failure/);
  for (const collection of [COLLECTIONS.accounts, COLLECTIONS.codes, COLLECTIONS.devices, COLLECTIONS.receipts]) {
    assert.equal([...f.repo.rows.keys()].filter(k => k.startsWith(`${collection}/`)).length, 0);
  }
});

test('device cap rejects third-device activation without consuming its code or changing expiry', async () => {
  const f = fixture(); const first = await f.activate(); await f.bind(2);
  const code = f.code(365); await rejected(f.activate(code, 3), 'DEVICE_LIMIT_REACHED');
  assert.equal(f.repo.get(COLLECTIONS.codes, sha256(normalizeActivationCode(code))), undefined);
  assert.equal((await f.call({ action: 'status' })).entitlement.expiresAt, first.entitlement.expiresAt);
  await f.call({ action: 'revoke', requestId: randomUUID(), deviceId: deviceId(2) });
  const replacement = await f.activate(code, 3); assert.equal(replacement.device.slotIndex, 1);
  assert.equal((await f.call({ action: 'devices' })).devices.length, 2);
});

test('same-account reused code binds without adding time; new code preserves license and uses max expiry', async () => {
  const f = fixture(), code = f.code(30), first = await f.activate(code);
  f.advance(constants.dayMs);
  const duplicate = await f.activate(code, 2); assert.equal(duplicate.entitlement.expiresAt, first.entitlement.expiresAt);
  assert.equal(duplicate.entitlement.licenseId, first.entitlement.licenseId);
  const short = await f.activate(f.code(7)); assert.equal(short.entitlement.expiresAt, first.entitlement.expiresAt);
  const extended = await f.activate(f.code(60));
  assert.equal(Date.parse(extended.entitlement.expiresAt), f.time() + 60 * constants.dayMs);
  assert.equal(extended.entitlement.licenseId, first.entitlement.licenseId);
  await rejected(f.activate(code, 1, 'different-owner'), 'ACTIVATION_CODE_UNAVAILABLE');
});

test('lost bind response can be replayed without persisting plaintext token', async () => {
  const f = fixture(); await f.activate();
  const request = { action: 'bind', requestId: randomUUID(), deviceId: deviceId(1), deviceName: 'Synthetic', appVersion: 'test' };
  const bound = await f.call(request); f.advance(10_000);
  assert.deepEqual(await f.call(request), bound);
  const receipt = f.repo.get(COLLECTIONS.receipts, sha256(`${signer.productId}\0${uid}\0${request.requestId}`));
  assert.equal(receipt.result.leaseToken, undefined); assert.ok(receipt.leaseTokenEnvelope);
  assert.ok(!JSON.stringify(receipt).includes(bound.leaseToken));
  receipt.leaseTokenEnvelope = `${receipt.leaseTokenEnvelope[0] === 'A' ? 'B' : 'A'}${receipt.leaseTokenEnvelope.slice(1)}`;
  await rejected(f.call(request), 'DATA_INTEGRITY_ERROR');
});

test('renewal rotates tokens and replaying its triple never extends the lease twice', async () => {
  const f = fixture(), bound = await f.activate(); f.advance(60_000);
  const request = f.renew(bound), refreshed = await f.call(request); f.advance(90_000);
  assert.equal(refreshed.leaseToken, request.nextLeaseToken);
  assert.deepEqual(await f.call(request), refreshed);
  assert.deepEqual(await f.call({ ...request, requestId: randomUUID() }), refreshed);
  await rejected(f.call({ ...request, requestId: randomUUID(), renewalId: `renew_${'f'.repeat(32)}`, nextLeaseToken: 'b'.repeat(64) }), 'DEVICE_REVOKED');
  assert.ok(!JSON.stringify([...f.repo.rows]).includes(refreshed.leaseToken));
});

test('concurrent different renewals using one old token have a single winner', async () => {
  const f = fixture(), first = await f.activate();
  const results = await Promise.allSettled([f.call(f.renew(first, 'a'.repeat(64))), f.call(f.renew(first, 'b'.repeat(64)))]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'DEVICE_REVOKED');
});

test('revoke racing a renewal cannot resurrect a binding or an old receipt', async () => {
  const f = fixture(), first = await f.activate();
  const request = f.renew(first); await f.call(request);
  const results = await Promise.allSettled([
    f.call({ action: 'revoke', requestId: randomUUID(), deviceId: deviceId(1) }),
    f.call({ ...request, requestId: randomUUID() }),
  ]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected');
  assert.equal((await f.call({ action: 'devices' })).devices.length, 0);
  await rejected(f.call(request), 'DEVICE_REVOKED');
  const next = await f.bind(1); assert.notEqual(next.device.bindingId, first.device.bindingId);
  await rejected(f.call(request), 'DEVICE_REVOKED');
});

test('legacy slotless and tokenless installation renews once into the new token protocol', async () => {
  const f = fixture(), first = await f.activate();
  const aid = accountId(signer.productId, uid), did = deviceDocId(signer.productId, uid, deviceId(1));
  const account = f.repo.get(COLLECTIONS.accounts, aid), device = account.devices[sha256(deviceId(1))];
  delete device.slotIndex; delete device.leaseTokenHash;
  const row = f.repo.get(COLLECTIONS.devices, did); delete row.slotIndex; delete row.leaseTokenHash;
  for (const key of f.repo.rows.keys()) if (key.startsWith(`${COLLECTIONS.devices}/slot_`)) f.repo.rows.delete(key);
  const request = { action: 'renew', requestId: randomUUID(), deviceId: deviceId(1), bindingId: first.device.bindingId };
  const migrated = await f.call(request);
  assert.equal(migrated.device.slotIndex, 0); assert.equal(migrated.device.bindingId, first.device.bindingId);
  assert.equal((await f.call({ action: 'devices' })).devices.length, 1); assert.match(migrated.leaseToken, /^[a-f0-9]{64}$/);
  await rejected(f.call({ ...request, requestId: randomUUID() }), 'DEVICE_REVOKED');
  assert.equal((await f.call(f.renew(migrated))).leaseToken, 'a'.repeat(64));
});

test('global cap changes apply to old grants and out-of-range slots immediately', async () => {
  const f = fixture(); await f.activate(); await f.bind(2);
  const lower = createLicenseService({ ...f.options, maxDevices: 1 });
  assert.equal((await f.call({ action: 'devices' }, uid, lower)).maxDevices, 1);
  await rejected(f.call({ action: 'bind', requestId: randomUUID(), deviceId: deviceId(2), deviceName: 'Second', appVersion: 'test' }, uid, lower), 'DEVICE_LIMIT_REACHED');
  await f.call({ action: 'revoke', requestId: randomUUID(), deviceId: deviceId(1) }, uid, lower);
  await rejected(f.call({ action: 'bind', requestId: randomUUID(), deviceId: deviceId(3), deviceName: 'Third', appVersion: 'test' }, uid, lower), 'DEVICE_LIMIT_REACHED');
  await f.call({ action: 'revoke', requestId: randomUUID(), deviceId: deviceId(2) }, uid, lower);
  const third = await f.call({ action: 'bind', requestId: randomUUID(), deviceId: deviceId(3), deviceName: 'Third', appVersion: 'test' }, uid, lower);
  assert.equal(third.device.slotIndex, 0);
});

test('expired lease can renew online but signed offline time never exceeds entitlement', async () => {
  const f = fixture(); const first = await f.activate(f.code(8)); f.advance(7 * constants.dayMs + 1);
  const refreshed = await f.call(f.renew(first));
  assert.equal(refreshed.leaseExpiresAt, refreshed.entitlement.expiresAt);
  f.advance(constants.dayMs); await rejected(f.call(f.renew(refreshed, 'b'.repeat(64))), 'LICENSE_EXPIRED');
});

test('receipt encryption and signer configuration reject wrong keys and malformed data', () => {
  const otherSigner = createSigner({ ...keyPair(), keyId: signer.keyId, issuer: signer.issuer, audience: signer.audience, productId: signer.productId });
  const token = 'a'.repeat(64), envelope = signer.sealLeaseToken(token);
  assert.equal(signer.openLeaseToken(envelope), token);
  assert.throws(() => otherSigner.openLeaseToken(envelope), error => error.code === 'DATA_INTEGRITY_ERROR');
  assert.throws(() => signer.openLeaseToken('invalid'), error => error.code === 'DATA_INTEGRITY_ERROR');
  assert.throws(() => createSigner({ privateKeyPem: 'invalid', keyId: 'bad', issuer: 'x', audience: 'x', productId: 'x' }));
  assert.throws(() => createLicenseService({ repo: new MemoryRepo(), signer, maxDevices: 0 }), error => error.code === 'SERVICE_UNCONFIGURED');
});

test('corrupt device maps and divergent token hashes fail closed during migration and renewal', async () => {
  const f = fixture(), bound = await f.activate();
  const aid = accountId(signer.productId, uid);
  const deviceRow = f.repo.get(COLLECTIONS.devices, deviceDocId(signer.productId, uid, deviceId(1)));
  deviceRow.leaseTokenHash = 'not-the-canonical-token-hash';
  await rejected(f.call(f.renew(bound)), 'DATA_INTEGRITY_ERROR');
  f.repo.get(COLLECTIONS.accounts, aid).expiresAt = 'invalid-date'; assert.equal((await f.call({ action: 'status' })).status, 'invalid');
  f.repo.get(COLLECTIONS.accounts, aid).devices = [];
  await rejected(f.call({ action: 'status' }), 'DATA_INTEGRITY_ERROR');
  assert.ok(Array.isArray(f.repo.get(COLLECTIONS.accounts, aid).devices));
});
