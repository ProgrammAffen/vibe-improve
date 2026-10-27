import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, randomBytes, randomUUID, sign, verify } from 'node:crypto';
import { ActivationCodeError, normalizeActivationCode, verifyActivationCode } from './activation-code-v2.mjs';

export const COLLECTIONS = Object.freeze({
  accounts: 'vi_license_accounts', codes: 'vi_license_activation_codes',
  devices: 'vi_license_devices', receipts: 'vi_license_receipts', limits: 'vi_license_rate_limits',
});
export class LicenseError extends Error {
  constructor(code, retryable = false, diagnosticReason) { super(code); this.code = code; this.retryable = retryable; this.diagnosticReason = diagnosticReason; }
}
const fail = (code, diagnosticReason) => { throw new LicenseError(code, false, diagnosticReason); };
export const sha256 = (text) => createHash('sha256').update(text).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const accountId = (productId, uid) => sha256(`${productId}\0${uid}`);
export const deviceDocId = (productId, uid, deviceId) => sha256(`${productId}\0${uid}\0${deviceId}`);
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function string(value, max, pattern) {
  if (typeof value !== 'string' || !value || value.length > max || /[\u0000-\u001f\u007f]/u.test(value) || (pattern && !pattern.test(value))) fail('INVALID_REQUEST');
  return value;
}
export function normalizeCode(value) {
  if (typeof value === 'string' && /^VI1-[A-Fa-f0-9]{64}$/.test(value)) return value.toUpperCase();
  try { return normalizeActivationCode(value); }
  catch { fail('INVALID_ACTIVATION_CODE', 'activation_format_invalid'); }
}
export function validateGrant(value, now = Date.now()) {
  if (!plain(value) || !Number.isInteger(value.maxDevices) || value.maxDevices < 1 || value.maxDevices > 100) fail('INVALID_GRANT');
  if (!Array.isArray(value.features) || value.features.length < 1 || value.features.length > 64 || new Set(value.features).size !== value.features.length) fail('INVALID_GRANT');
  if (value.features.some(f => typeof f !== 'string' || f.length > 80 || /[\u0000-\u001f\u007f]/u.test(f) || !/^[a-z][a-z0-9._:-]*$/.test(f))) fail('INVALID_GRANT');
  const expiry = Date.parse(value.expiresAt);
  if (typeof value.expiresAt !== 'string' || !Number.isFinite(expiry) || new Date(expiry).toISOString() !== value.expiresAt || expiry <= now) fail('GRANT_EXPIRED');
  return { maxDevices: value.maxDevices, features: [...value.features].sort(), expiresAt: value.expiresAt };
}
export function createSigner({ privateKeyPem, keyId, issuer, audience, productId }) {
  for (const v of [keyId, issuer, audience, productId]) string(v, 200);
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== 'ed25519') fail('SIGNING_KEY_INVALID');
  const publicKey = createPublicKey(privateKey);
  const receiptKey = createHash('sha256').update('vibe-improve:lease-receipt:v2\0')
    .update(privateKey.export({ type: 'pkcs8', format: 'der' })).digest();
  const receiptAAD = Buffer.from(canonical({ domain: 'vibe-improve:lease-receipt:v2', keyId, issuer, audience, productId }));
  return {
    keyId, issuer, audience, productId,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    issue(fields) {
      const payload = Buffer.from(canonical({ schemaVersion: 1, keyId, issuer, audience, productId, ...fields })).toString('base64url');
      return { algorithm: 'Ed25519', keyId, payload, signature: sign(null, Buffer.from(payload, 'ascii'), privateKey).toString('base64url') };
    },
    sealLeaseToken(token) {
      if (!/^[a-f0-9]{64}$/.test(token)) fail('DATA_INTEGRITY_ERROR');
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', receiptKey, nonce);
      cipher.setAAD(receiptAAD);
      const ciphertext = Buffer.concat([cipher.update(token, 'ascii'), cipher.final()]);
      return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString('base64url');
    },
    openLeaseToken(envelope) {
      try {
        if (typeof envelope !== 'string' || !/^[A-Za-z0-9_-]{123}$/.test(envelope)) throw new Error();
        const bytes = Buffer.from(envelope, 'base64url');
        if (bytes.length !== 92 || bytes.toString('base64url') !== envelope) throw new Error();
        const decipher = createDecipheriv('aes-256-gcm', receiptKey, bytes.subarray(0, 12));
        decipher.setAAD(receiptAAD); decipher.setAuthTag(bytes.subarray(76));
        const token = Buffer.concat([decipher.update(bytes.subarray(12, 76)), decipher.final()]).toString('ascii');
        if (!/^[a-f0-9]{64}$/.test(token)) throw new Error();
        return token;
      } catch { fail('DATA_INTEGRITY_ERROR'); }
    },
  };
}
export function verifyCertificate(certificate, publicKeyPem) {
  if (!plain(certificate) || certificate.algorithm !== 'Ed25519' || !/^[A-Za-z0-9_-]+$/.test(certificate.payload ?? '') || !/^[A-Za-z0-9_-]+$/.test(certificate.signature ?? '')) return null;
  try {
    const key = createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== 'ed25519' || !verify(null, Buffer.from(certificate.payload, 'ascii'), key, Buffer.from(certificate.signature, 'base64url'))) return null;
    const payload = JSON.parse(Buffer.from(certificate.payload, 'base64url').toString('utf8'));
    return payload.keyId === certificate.keyId && payload.schemaVersion === 1 ? payload : null;
  } catch { return null; }
}
const ACTION_FIELDS = {
  status: ['deviceId'], activate: ['requestId', 'activationCode', 'deviceId', 'deviceName', 'appVersion'],
  bind: ['requestId', 'deviceId', 'deviceName', 'appVersion'], devices: ['currentDeviceId'],
  revoke: ['requestId', 'deviceId'], renew: ['requestId', 'deviceId', 'bindingId', 'leaseToken', 'renewalId', 'nextLeaseToken'],
};
function request(raw) {
  if (!plain(raw) || !Object.hasOwn(ACTION_FIELDS, raw.action)) fail('INVALID_REQUEST');
  if (Buffer.byteLength(JSON.stringify(raw)) > 4096 || Object.keys(raw).some(k => k !== 'action' && !ACTION_FIELDS[raw.action].includes(k))) fail('INVALID_REQUEST');
  const req = { ...raw };
  if (['activate', 'bind', 'revoke', 'renew'].includes(req.action)) string(req.requestId, 128, /^[A-Za-z0-9_-]{16,128}$/);
  for (const k of ['deviceId', 'currentDeviceId']) if (req[k] !== undefined) string(req[k], 128, /^[A-Za-z0-9_-]{16,128}$/);
  if (['activate', 'bind', 'revoke', 'renew'].includes(req.action) && !req.deviceId) fail('INVALID_REQUEST');
  if (req.action === 'bind' || req.action === 'activate') { string(req.deviceName, 80); string(req.appVersion, 40); }
  if (req.action === 'renew') {
    string(req.bindingId, 80, /^[A-Za-z0-9_-]{16,80}$/);
    if (['leaseToken', 'renewalId', 'nextLeaseToken'].some(k => req[k] !== undefined)) {
      string(req.leaseToken, 64, /^[a-f0-9]{64}$/);
      string(req.renewalId, 38, /^renew_[a-f0-9]{32}$/);
      string(req.nextLeaseToken, 64, /^[a-f0-9]{64}$/);
      if (req.nextLeaseToken === req.leaseToken) fail('INVALID_REQUEST');
    }
  }
  if (req.action === 'activate') req.activationCode = normalizeCode(req.activationCode);
  return req;
}
function active(account, now) {
  if (!account?.licenseId) fail('LICENSE_REQUIRED');
  if (account.status === 'revoked') fail('LICENSE_REVOKED');
  if (account.status !== 'active' || !Number.isFinite(Date.parse(account.expiresAt))) fail('LICENSE_INVALID');
  if (Date.parse(account.expiresAt) <= now) fail('LICENSE_EXPIRED');
}
function entitlement(account, maxDevices) {
  return account?.licenseId ? { licenseId: account.licenseId, productId: account.productId, features: account.features,
    maxDevices, expiresAt: account.expiresAt, issuedAt: account.issuedAt } : null;
}
function publicDevice(device, currentId) {
  return { deviceId: device.deviceId, bindingId: device.bindingId, deviceName: device.deviceName, appVersion: device.appVersion,
    slotIndex: device.slotIndex, boundAt: device.boundAt, lastSeenAt: device.lastSeenAt,
    leaseExpiresAt: device.leaseExpiresAt, offlineUntil: device.offlineUntil, isCurrent: device.deviceId === currentId };
}
export const slotDocId = (productId, uid, licenseId, slotIndex) => `slot_${sha256(`${productId}\0${uid}\0${licenseId}`).slice(0, 32)}_${slotIndex}`;
function migrateSlots(account) {
  if (!account) return;
  if (account.devices === undefined) account.devices = {};
  if (!plain(account.devices)) fail('DATA_INTEGRITY_ERROR');
  const used = new Set();
  const missing = [];
  for (const [key, device] of Object.entries(account.devices)) {
    if (!plain(device) || !device.deviceId || key !== sha256(device.deviceId)) fail('DATA_INTEGRITY_ERROR');
    if (Number.isSafeInteger(device.slotIndex) && device.slotIndex >= 0) {
      if (used.has(device.slotIndex)) fail('DATA_INTEGRITY_ERROR');
      used.add(device.slotIndex);
    } else missing.push(device);
  }
  for (const device of missing) { let slot = 0; while (used.has(slot)) slot++; device.slotIndex = slot; used.add(slot); }
}
export function createLicenseService({ repo, signer, leaseSeconds = 168 * 3600, maxDevices = 2, activationCodePublicKeyPem,
  offlineGraceSeconds = 0, rateLimitPerMinute = 60, now = Date.now, uuid = randomUUID }) {
  if (!repo?.transaction || !signer?.issue || !signer?.sealLeaseToken || !signer?.openLeaseToken
    || !Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 31_536_000
    || !Number.isSafeInteger(maxDevices) || maxDevices < 1 || maxDevices > 100
    || !Number.isSafeInteger(offlineGraceSeconds) || offlineGraceSeconds < 0 || offlineGraceSeconds > 31_536_000
    || !Number.isInteger(rateLimitPerMinute) || rateLimitPerMinute < 1) fail('SERVICE_UNCONFIGURED');
  const productId = signer.productId;
  async function limit(uid, at) {
    const window = Math.floor(at / 60_000);
    await repo.transaction(async tx => {
      const id = sha256(`${productId}\0${uid}\0${window}`);
      const row = await tx.get(COLLECTIONS.limits, id);
      if ((row?.count ?? 0) >= rateLimitPerMinute) throw new LicenseError('RATE_LIMITED', true);
      await tx.put(COLLECTIONS.limits, id, { count: (row?.count ?? 0) + 1, window, expiresAt: new Date((window + 2) * 60_000).toISOString() });
    });
  }
  function lease(account, device, at) {
    const issuedAt = new Date(at).toISOString(), expiry = Date.parse(account.expiresAt);
    const leaseExpiresAt = new Date(Math.min(expiry, at + leaseSeconds * 1000)).toISOString();
    const offlineUntil = new Date(Math.min(expiry, Date.parse(leaseExpiresAt) + offlineGraceSeconds * 1000)).toISOString();
    const certificate = signer.issue({ licenseId: account.licenseId, userId: account.userId, deviceId: device.deviceId,
      bindingId: device.bindingId, features: account.features, issuedAt, notBefore: issuedAt,
      expiresAt: account.expiresAt, leaseExpiresAt, offlineUntil });
    return { certificate, leaseExpiresAt, offlineUntil, lastSeenAt: issuedAt };
  }
  function capacity(account, deviceId) {
    const devices = Object.values(account.devices), current = account.devices[sha256(deviceId)];
    if ((current && current.slotIndex >= maxDevices) || (!current && devices.length >= maxDevices)) fail('DEVICE_LIMIT_REACHED');
    if (current) return current.slotIndex;
    const occupied = new Set(devices.map(d => d.slotIndex));
    for (let slot = 0; slot < maxDevices; slot++) if (!occupied.has(slot)) return slot;
    fail('DEVICE_LIMIT_REACHED');
  }
  async function saveDevice(tx, account, device, token, at) {
    const issued = lease(account, device, at);
    Object.assign(device, { leaseTokenHash: sha256(token), leaseExpiresAt: issued.leaseExpiresAt,
      offlineUntil: issued.offlineUntil, lastSeenAt: issued.lastSeenAt });
    account.devices[sha256(device.deviceId)] = device;
    account.maxDevices = maxDevices;
    account.revision = (account.revision ?? 0) + 1;
    await tx.put(COLLECTIONS.accounts, accountId(productId, account.userId), account);
    await tx.put(COLLECTIONS.devices, deviceDocId(productId, account.userId, device.deviceId), {
      ...device, userId: account.userId, productId, licenseId: account.licenseId, status: 'active' });
    for (const bound of Object.values(account.devices)) await tx.put(COLLECTIONS.devices,
      slotDocId(productId, account.userId, account.licenseId, bound.slotIndex), {
        kind: 'slot', productId, userId: account.userId, licenseId: account.licenseId, slotIndex: bound.slotIndex,
        deviceId: bound.deviceId, bindingId: bound.bindingId, status: 'active' });
    return { serverNow: new Date(at).toISOString(), status: 'valid', entitlement: entitlement(account, maxDevices),
      device: publicDevice(device, device.deviceId), certificate: issued.certificate, leaseToken: token,
      leaseExpiresAt: issued.leaseExpiresAt, maxDevices, leaseDurationHours: leaseSeconds / 3600 };
  }
  async function bind(tx, account, req, at) {
    active(account, at);
    const slotIndex = capacity(account, req.deviceId), previous = account.devices[sha256(req.deviceId)];
    const slot = await tx.get(COLLECTIONS.devices, slotDocId(productId, account.userId, account.licenseId, slotIndex));
    if (slot?.status === 'active' && (slot.deviceId !== req.deviceId || slot.bindingId !== previous?.bindingId)) fail('DATA_INTEGRITY_ERROR');
    const device = previous ? { ...previous } : { deviceId: req.deviceId, bindingId: uuid(), boundAt: new Date(at).toISOString() };
    Object.assign(device, { slotIndex, deviceName: req.deviceName, appVersion: req.appVersion });
    delete device.lastRenewalId; delete device.lastRenewalPreviousTokenHash; delete device.lastRenewalReceiptId;
    return saveDevice(tx, account, device, randomBytes(32).toString('hex'), at);
  }
  function readV2(code, at) {
    try { return verifyActivationCode(code, activationCodePublicKeyPem, at); }
    catch (e) {
      if (e instanceof ActivationCodeError) fail(e.code, e.code === 'INVALID_ACTIVATION_CODE' ? 'activation_signature_invalid' : undefined);
      throw e;
    }
  }
  return {
    async handle(raw, identity) {
      if (!identity || typeof identity.uid !== 'string' || !identity.uid || identity.uid.length > 256 || identity.anonymous !== false) fail('AUTH_REQUIRED');
      const req = request(raw), uid = identity.uid, at = now();
      if (!Number.isSafeInteger(at)) fail('SERVICE_UNAVAILABLE');
      await limit(uid, at);
      const aid = accountId(productId, uid);
      return repo.transaction(async tx => {
        let account = await tx.get(COLLECTIONS.accounts, aid);
        if (account && (account.userId !== uid || account.productId !== productId)) fail('DATA_INTEGRITY_ERROR');
        migrateSlots(account);
        const serverNow = new Date(at).toISOString();
        if (req.action === 'status' || req.action === 'devices') {
          const status = !account?.licenseId ? 'unlicensed' : account.status === 'revoked' ? 'revoked'
            : !Number.isFinite(Date.parse(account.expiresAt)) ? 'invalid'
              : Date.parse(account.expiresAt) <= at ? 'expired' : account.status === 'active' ? 'valid' : 'invalid';
          const devices = Object.values(account?.devices ?? {}).map(d => publicDevice(d, req.currentDeviceId ?? req.deviceId));
          return req.action === 'devices' ? { serverNow, entitlement: entitlement(account, maxDevices), maxDevices, devices }
            : { serverNow, status, entitlement: entitlement(account, maxDevices), device: devices.find(d => d.deviceId === req.deviceId) ?? null };
        }
        const rid = sha256(`${productId}\0${uid}\0${req.requestId}`);
        const hashable = { ...req };
        for (const key of ['activationCode', 'leaseToken', 'nextLeaseToken']) if (hashable[key]) hashable[key] = sha256(hashable[key]);
        const requestHash = sha256(canonical(hashable));
        const prior = await tx.get(COLLECTIONS.receipts, rid);
        if (prior) {
          if (prior.requestHash !== requestHash) fail('IDEMPOTENCY_KEY_REUSED');
          if (prior.guard) {
            active(account, at);
            if (account.licenseId !== prior.guard.licenseId) fail('LICENSE_CHANGED');
            if (prior.guard.deviceId) {
              const bound = account.devices?.[sha256(prior.guard.deviceId)];
              if (!bound || bound.bindingId !== prior.guard.bindingId
                || (prior.guard.leaseTokenHash && bound.leaseTokenHash !== prior.guard.leaseTokenHash)) fail('DEVICE_REVOKED');
              if (bound.slotIndex >= maxDevices) fail('DEVICE_LIMIT_REACHED');
            }
          }
          return { ...prior.result, ...(prior.leaseTokenEnvelope ? { leaseToken: signer.openLeaseToken(prior.leaseTokenEnvelope) } : {}) };
        }
        let result, guard = null;
        if (req.action === 'activate') {
          const hash = sha256(req.activationCode), code = await tx.get(COLLECTIONS.codes, hash);
          const legacy = req.activationCode.startsWith('VI1-');
          if (account?.status === 'revoked') fail('LICENSE_REVOKED');
          let verified;
          if (!legacy) verified = readV2(req.activationCode, at);
          if (code) {
            if (code.productId !== productId) fail('ACTIVATION_CODE_UNAVAILABLE', 'activation_wrong_product');
            if (code.codeHash !== hash) fail('ACTIVATION_CODE_UNAVAILABLE', 'activation_record_invalid');
            if (code.status === 'claimed') {
              if (code.claimedBy !== uid) fail('ACTIVATION_CODE_UNAVAILABLE', 'activation_used');
              if (!account || account.licenseId !== code.licenseId) fail('LICENSE_CHANGED');
              active(account, at);
            } else if (legacy && code.status === 'available') {
              const grant = validateGrant(code, at);
              account = { ...account, userId: uid, productId, licenseId: account?.licenseId || uuid(), status: 'active',
                features: [...new Set([...(account?.features ?? []), ...grant.features])].sort(), tier: account?.tier || 'pro',
                expiresAt: new Date(Math.max(Date.parse(account?.expiresAt) || 0, Date.parse(grant.expiresAt))).toISOString(),
                issuedAt: account?.issuedAt || serverNow, devices: account?.devices ?? {}, revision: account?.revision ?? 0 };
              capacity(account, req.deviceId);
              await tx.put(COLLECTIONS.codes, hash, { ...code, status: 'claimed', claimedBy: uid, claimedAt: serverNow, licenseId: account.licenseId });
            } else fail('ACTIVATION_CODE_UNAVAILABLE', 'activation_used');
          } else {
            if (legacy) fail('ACTIVATION_CODE_UNAVAILABLE', 'activation_not_found');
            account = { ...account, userId: uid, productId, licenseId: account?.licenseId || uuid(), status: 'active',
              tier: verified.tier, features: [...new Set([...(account?.features ?? []), ...verified.features])].sort(),
              expiresAt: new Date(Math.max(Date.parse(account?.expiresAt) || 0, at + verified.durationDays * 86_400_000)).toISOString(),
              issuedAt: account?.issuedAt || serverNow, devices: account?.devices ?? {}, revision: account?.revision ?? 0 };
            capacity(account, req.deviceId);
            await tx.put(COLLECTIONS.codes, hash, { schemaVersion: 2, codeHash: hash, payloadHash: verified.payloadHash,
              productId, profileId: verified.profileId, tier: verified.tier, durationDays: verified.durationDays,
              features: verified.features, status: 'claimed', claimedBy: uid, claimedAt: serverNow,
              licenseId: account.licenseId, firstDeviceId: req.deviceId });
          }
          result = await bind(tx, account, req, at);
        } else {
          if (req.action !== 'revoke') active(account, at);
          if (!account?.licenseId) fail('LICENSE_REQUIRED');
          const key = sha256(req.deviceId), did = deviceDocId(productId, uid, req.deviceId);
          const row = await tx.get(COLLECTIONS.devices, did), bound = account.devices[key];
          if (req.action === 'revoke') {
            if (!bound) { if (!row) fail('DEVICE_NOT_FOUND'); }
            else {
              delete account.devices[key]; account.revision = (account.revision ?? 0) + 1;
              await tx.put(COLLECTIONS.accounts, aid, account);
              await tx.put(COLLECTIONS.devices, did, { ...row, ...bound, userId: uid, productId, licenseId: account.licenseId, status: 'revoked', revokedAt: serverNow });
              await tx.put(COLLECTIONS.devices, slotDocId(productId, uid, account.licenseId, bound.slotIndex), {
                kind: 'slot', productId, userId: uid, licenseId: account.licenseId, slotIndex: bound.slotIndex,
                deviceId: bound.deviceId, bindingId: bound.bindingId, status: 'revoked', revokedAt: serverNow });
            }
            result = { serverNow, deviceId: req.deviceId, revoked: true };
          } else if (req.action === 'bind') result = await bind(tx, account, req, at);
          else {
            if (!bound || !row || row.status !== 'active' || row.licenseId !== account.licenseId || bound.bindingId !== req.bindingId
              || row.bindingId !== req.bindingId || row.deviceId !== req.deviceId || row.userId !== uid || row.productId !== productId) fail('DEVICE_REVOKED');
            if (bound.slotIndex >= maxDevices) fail('DEVICE_LIMIT_REACHED');
            const device = { ...bound };
            if (row.leaseTokenHash !== device.leaseTokenHash) fail('DATA_INTEGRITY_ERROR');
            let token;
            if (!device.leaseTokenHash && !row.leaseTokenHash) {
              if (req.leaseToken) fail('DEVICE_REVOKED');
              token = randomBytes(32).toString('hex');
            } else {
              if (!req.leaseToken || !req.renewalId || !req.nextLeaseToken) fail('DEVICE_REVOKED');
              const previousHash = sha256(req.leaseToken), nextHash = sha256(req.nextLeaseToken);
              if (device.lastRenewalId === req.renewalId && device.lastRenewalPreviousTokenHash === previousHash && device.leaseTokenHash === nextHash) {
                const replay = device.lastRenewalReceiptId && await tx.get(COLLECTIONS.receipts, device.lastRenewalReceiptId);
                if (!replay || replay.guard?.bindingId !== device.bindingId || replay.guard?.leaseTokenHash !== nextHash) fail('DATA_INTEGRITY_ERROR');
                return { ...replay.result, leaseToken: req.nextLeaseToken };
              }
              if (device.leaseTokenHash !== previousHash || row.leaseTokenHash !== previousHash) fail('DEVICE_REVOKED');
              token = req.nextLeaseToken;
              device.lastRenewalId = req.renewalId; device.lastRenewalPreviousTokenHash = previousHash; device.lastRenewalReceiptId = rid;
            }
            result = await saveDevice(tx, account, device, token, at);
          }
        }
        if (result.certificate) guard = { licenseId: account.licenseId, deviceId: result.device.deviceId,
          bindingId: result.device.bindingId, leaseTokenHash: sha256(result.leaseToken) };
        const { leaseToken, ...storedResult } = result;
        await tx.put(COLLECTIONS.receipts, rid, { userId: uid, productId, action: req.action, requestHash, result: storedResult,
          ...(leaseToken && { leaseTokenEnvelope: signer.sealLeaseToken(leaseToken) }), guard, createdAt: serverNow });
        return result;
      });
    },
  };
}
