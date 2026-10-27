const invalid = () => { throw Object.assign(new Error('CERTIFICATE_INVALID'), {code:'CERTIFICATE_INVALID'}); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 256) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);

function decode64(value, max) {
  if (!text(value, max) || /[^A-Za-z0-9_-]/u.test(value) || value.length % 4 === 1) invalid();
  const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')), c => c.charCodeAt(0));
  if (btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '') !== value) invalid();
  return bytes;
}

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) invalid();
  const result = Date.parse(value);
  if (!Number.isFinite(result) || new Date(result).toISOString() !== value) invalid();
  return result;
}

export async function verifyLicenseCertificate(certificate, trust, expected) {
  try {
    if (!object(certificate) || !object(trust) || !object(expected) || certificate.algorithm !== 'Ed25519') invalid();
    for (const field of ['keyId','issuer','audience','productId']) if (!text(trust[field], 200)) invalid();
    for (const field of ['userId','deviceId','bindingId','licenseId']) if (!text(expected[field])) invalid();
    if (certificate.keyId !== trust.keyId) invalid();
    const payload = decode64(certificate.payload, 16_384);
    const signature = decode64(certificate.signature, 128);
    if (signature.length !== 64) invalid();
    const key = await globalThis.crypto.subtle.importKey('spki', decode64(trust.publicKeySpki, 4096), {name:'Ed25519'}, false, ['verify']);
    if (!await globalThis.crypto.subtle.verify('Ed25519', key, signature, new TextEncoder().encode(certificate.payload))) invalid();
    const claims = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(payload));
    if (!object(claims) || claims.schemaVersion !== 1) invalid();
    for (const field of ['keyId','issuer','audience','productId']) if (claims[field] !== trust[field]) invalid();
    for (const field of ['userId','deviceId','bindingId','licenseId']) if (claims[field] !== expected[field]) invalid();
    const features = claims.features;
    if (!Array.isArray(features) || features.length < 1 || features.length > 64 || new Set(features).size !== features.length) invalid();
    if (features.some(feature => !text(feature, 80) || !/^[a-z]/u.test(feature) || /[^a-z0-9._:-]/u.test(feature))) invalid();
    const now = expected.now ?? Date.now();
    if (!Number.isSafeInteger(now) || now < 0) invalid();
    const issuedAt = timestamp(claims.issuedAt);
    const notBefore = timestamp(claims.notBefore);
    const expiresAt = timestamp(claims.expiresAt);
    const leaseExpiresAt = timestamp(claims.leaseExpiresAt);
    const offlineUntil = timestamp(claims.offlineUntil);
    if (issuedAt > now + 120_000 || notBefore > now || expiresAt <= now || leaseExpiresAt <= now || issuedAt >= leaseExpiresAt || leaseExpiresAt - issuedAt > 604_800_000 || notBefore >= leaseExpiresAt || leaseExpiresAt > expiresAt || offlineUntil < leaseExpiresAt || offlineUntil > expiresAt) invalid();
    return Object.freeze({...claims,features:Object.freeze([...features])});
  } catch { invalid(); }
}

export async function verifyServerTimeProof(certificate, trust, expected) {
  try {
    if (!object(certificate) || !object(trust) || !object(expected) || certificate.algorithm !== 'Ed25519' || certificate.keyId !== trust.keyId || !text(expected.userId) || !text(expected.nonce,128)) invalid();
    const payload = decode64(certificate.payload,4096), signature = decode64(certificate.signature,128);
    const key = await globalThis.crypto.subtle.importKey('spki',decode64(trust.publicKeySpki,4096),{name:'Ed25519'},false,['verify']);
    if (signature.length !== 64 || !await globalThis.crypto.subtle.verify('Ed25519',key,signature,new TextEncoder().encode(certificate.payload))) invalid();
    const claims = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(payload));
    if (!object(claims) || claims.schemaVersion !== 1 || claims.purpose !== 'server-time-v1' || claims.userId !== expected.userId || claims.nonce !== expected.nonce) invalid();
    for (const field of ['keyId','issuer','audience','productId']) if (!text(trust[field],200) || claims[field] !== trust[field]) invalid();
    return timestamp(claims.serverTime);
  } catch {invalid();}
}
