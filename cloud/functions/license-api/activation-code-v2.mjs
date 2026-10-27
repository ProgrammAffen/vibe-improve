import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';

export const constants = Object.freeze({
  alphabet: '23456789ABCDEFGHJKMNPQRSTUVWXYZ', prefix: 'VI', header: 0x21,
  domain: 'vibe-improve:activation:v2\0', epoch: Date.UTC(2026, 0, 1), dayMs: 86_400_000,
  payloadBytes: 13, frameBytes: 77, displayLength: 157, keyId: 'activation-code-v2',
});
export class ActivationCodeError extends Error {
  constructor(code = 'INVALID_ACTIVATION_CODE') { super(code); this.code = code; }
}
const invalid = () => { throw new ActivationCodeError(); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function normalizeActivationCode(value) {
  if (typeof value !== 'string' || value.length > 1024) invalid();
  const compact = value.replace(/[\s-]/gu, '').toUpperCase();
  const body = compact.startsWith(constants.prefix) ? compact.slice(2) : compact;
  if (body.length !== 124 || [...body].some(c => !constants.alphabet.includes(c))) invalid();
  return `${constants.prefix}${body}`;
}
function encode(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let number = BigInt(`0x${bytes.toString('hex') || '0'}`), result = '';
  const base = BigInt(constants.alphabet.length);
  while (number) { result = constants.alphabet[Number(number % base)] + result; number /= base; }
  return constants.alphabet[0].repeat(zeros) + result;
}
function decode(text) {
  let zeros = 0;
  while (zeros < text.length && text[zeros] === constants.alphabet[0]) zeros++;
  let number = 0n;
  for (const c of text) number = number * BigInt(constants.alphabet.length) + BigInt(constants.alphabet.indexOf(c));
  let bytes = Buffer.alloc(0);
  if (number) { let hex = number.toString(16); if (hex.length % 2) hex = `0${hex}`; bytes = Buffer.from(hex, 'hex'); }
  return Buffer.concat([Buffer.alloc(zeros), bytes]);
}
function verificationKey(pem) {
  try { const key = createPublicKey(pem); if (key.asymmetricKeyType !== 'ed25519') throw new Error(); return key; }
  catch { throw new ActivationCodeError('SERVICE_UNCONFIGURED'); }
}
export function verifyActivationCode(value, publicKeyPem, now = Date.now()) {
  const normalizedCode = normalizeActivationCode(value);
  const frame = decode(normalizedCode.slice(2));
  if (frame.length !== constants.frameBytes) invalid();
  const payload = frame.subarray(0, constants.payloadBytes);
  const key = verificationKey(publicKeyPem);
  if (!verify(null, Buffer.concat([Buffer.from(constants.domain), payload]), key, frame.subarray(constants.payloadBytes))) invalid();
  const durationDays = payload.readUInt16BE(1);
  const issuedAt = constants.epoch + payload.readUInt16BE(3) * constants.dayMs;
  const at = new Date(now).getTime();
  if (payload[0] !== constants.header || durationDays === 0 || !Number.isSafeInteger(at) || issuedAt > at + constants.dayMs) invalid();
  return { normalizedCode, codeHash: hash(normalizedCode), payloadHash: hash(payload), durationDays,
    issuedAt: new Date(issuedAt).toISOString(), nonce: payload.subarray(5).toString('hex'), profileId: 1,
    tier: 'pro', features: ['app.access'] };
}
export function encodeActivationCode({ durationDays, issuedAt = Date.now(), nonce = randomBytes(8) }, privateKeyPem) {
  if (!Number.isSafeInteger(durationDays) || durationDays < 1 || durationDays > 65535 || !Buffer.isBuffer(nonce) || nonce.length !== 8) invalid();
  const at = new Date(issuedAt).getTime();
  const issuedDay = Math.floor((at - constants.epoch) / constants.dayMs);
  if (!Number.isSafeInteger(issuedDay) || issuedDay < 0 || issuedDay > 65535) invalid();
  let key;
  try { key = createPrivateKey(privateKeyPem); if (key.asymmetricKeyType !== 'ed25519') throw new Error(); }
  catch { throw new ActivationCodeError('SERVICE_UNCONFIGURED'); }
  const payload = Buffer.alloc(constants.payloadBytes); payload[0] = constants.header;
  payload.writeUInt16BE(durationDays, 1); payload.writeUInt16BE(issuedDay, 3); nonce.copy(payload, 5);
  const signature = sign(null, Buffer.concat([Buffer.from(constants.domain), payload]), key);
  const body = encode(Buffer.concat([payload, signature]));
  const code = `${constants.prefix}-${body.match(/.{1,4}/gu).join('-')}`;
  if (code.length !== constants.displayLength) invalid();
  verifyActivationCode(code, createPublicKey(key).export({ type: 'spki', format: 'pem' }), at);
  return code;
}
