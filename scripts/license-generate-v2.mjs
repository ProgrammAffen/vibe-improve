#!/usr/bin/env node
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {createPrivateKey, createPublicKey, randomBytes} from 'node:crypto';
import {dirname, isAbsolute, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {encodeActivationCode, verifyActivationCode} from '../cloud/functions/license-api/activation-code-v2.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const productId = 'vibe-improve';
export class ActivationAdminError extends Error {
  constructor(code) {super(code); this.code = code;}
}
const fail = code => {throw new ActivationAdminError(code);};
const owned = info => typeof process.getuid !== 'function' || info.uid === process.getuid();
const inside = (base, target) => {
  const path = relative(base, target);
  return path && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

async function checkedDirectories(root, directory, io, {create = false, privateFrom} = {}) {
  const parts = relative(root, directory).split(sep).filter(Boolean);
  let cursor = root;
  for (const part of ['', ...parts]) {
    if (part) cursor = resolve(cursor, part);
    if (create && part) await io.mkdir(cursor, {mode: 0o700}).catch(error => {if (error.code !== 'EEXIST') throw error;});
    const info = await io.lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink() || !owned(info)) fail('ACTIVATION_UNSAFE_DIRECTORY');
    if (privateFrom && (cursor === privateFrom || inside(privateFrom, cursor)) && (info.mode & 0o777) !== 0o700) fail('ACTIVATION_UNSAFE_DIRECTORY');
  }
}

async function readCheckedFile(root, path, io, privateFile) {
  await checkedDirectories(root, dirname(path), io, {privateFrom: privateFile ? resolve(root, 'tmp/private') : undefined});
  const file = await io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || !owned(info) || info.size < 1 || info.size > 16_384 || (privateFile && (info.mode & 0o777) !== 0o600)) fail('ACTIVATION_UNSAFE_KEY_FILE');
    return await file.readFile('utf8');
  } finally {await file.close();}
}

async function signingMaterial(root, io) {
  let trust, privateKey, publicKey;
  const privatePem = await readCheckedFile(root, resolve(root, 'tmp/private/license-activation-key.pem'), io, true);
  try {
    trust = JSON.parse(await readCheckedFile(root, resolve(root, 'cloud/public-activation-key.json'), io, false));
    if (!trust || typeof trust !== 'object' || Array.isArray(trust) ||
        Object.keys(trust).sort().join(',') !== 'algorithm,keyId,productId,profileId,publicKeyPem,schemaVersion' ||
        trust.schemaVersion !== 2 || trust.algorithm !== 'Ed25519' || trust.productId !== productId || trust.profileId !== 1 ||
        typeof trust.keyId !== 'string' || !/^vi-activation-v2-[a-zA-Z0-9_-]{1,64}$/.test(trust.keyId) ||
        typeof trust.publicKeyPem !== 'string' || trust.publicKeyPem.length > 8192) fail('ACTIVATION_TRUST_INVALID');
    privateKey = createPrivateKey(privatePem);
    publicKey = createPublicKey(trust.publicKeyPem);
  } catch (error) {
    if (error instanceof ActivationAdminError) throw error;
    fail('ACTIVATION_KEY_INVALID');
  }
  if (privateKey.asymmetricKeyType !== 'ed25519' || publicKey.asymmetricKeyType !== 'ed25519') fail('ACTIVATION_KEY_INVALID');
  const actual = createPublicKey(privateKey).export({type: 'spki', format: 'der'});
  if (!actual.equals(publicKey.export({type: 'spki', format: 'der'}))) fail('ACTIVATION_KEY_MISMATCH');
  return {privatePem, trust};
}

async function writeNewPrivateJson(root, destination, batch, io) {
  const privateRoot = resolve(root, 'tmp/private');
  await checkedDirectories(root, dirname(destination), io, {create: true, privateFrom: privateRoot});
  try {await io.lstat(destination); fail('ACTIVATION_OUTPUT_EXISTS');}
  catch (error) {if (error.code !== 'ENOENT') throw error;}
  const temporary = resolve(dirname(destination), `.activation-${randomBytes(16).toString('hex')}.tmp`);
  let file, created = false;
  try {
    file = await io.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    created = true;
    await file.chmod(0o600);
    await file.writeFile(JSON.stringify(batch, null, 2) + '\n', 'utf8');
    await file.sync();
    await file.close(); file = undefined;
    try {await io.link(temporary, destination);}
    catch (error) {if (error.code === 'EEXIST') fail('ACTIVATION_OUTPUT_EXISTS'); throw error;}
    const directory = await io.open(dirname(destination), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {await directory.sync();} finally {await directory.close();}
  } finally {
    if (file) await file.close().catch(() => {});
    if (created) await io.unlink(temporary).catch(error => {if (error.code !== 'ENOENT') throw error;});
  }
  const directory = await io.open(dirname(destination), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {await directory.sync();} finally {await directory.close();}
}

export async function generateActivationCodeBatch({root = repoRoot, output, durationDays, count, now = Date.now(), io = fs}) {
  if (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > 65_535 ||
      !Number.isInteger(count) || count < 1 || count > 100 || !Number.isSafeInteger(now) || now < 0) fail('INVALID_ACTIVATION_ARGUMENTS');
  root = resolve(root);
  if (typeof output !== 'string' || !output || output.includes('\0')) fail('ACTIVATION_OUTPUT_REQUIRED');
  const destination = resolve(root, output);
  if (!inside(resolve(root, 'tmp/private'), destination) || !destination.endsWith('.json')) fail('ACTIVATION_OUTPUT_MUST_BE_PRIVATE_JSON');
  const {privatePem, trust} = await signingMaterial(root, io);
  const codes = [], seen = new Set();
  for (let index = 0; index < count; index++) {
    const code = encodeActivationCode({durationDays, issuedAt: now}, privatePem);
    const checked = verifyActivationCode(code, trust.publicKeyPem, now);
    if (checked.durationDays !== durationDays || checked.profileId !== 1 || seen.has(checked.codeHash)) fail('ACTIVATION_SELF_VERIFICATION_FAILED');
    seen.add(checked.codeHash);
    codes.push({code, codeHash: checked.codeHash, payloadHash: checked.payloadHash});
  }
  const batch = {schemaVersion: 2, algorithm: 'Ed25519', keyId: trust.keyId, productId, profileId: 1,
    tier: 'pro', features: ['app.access'], durationDays, issuedAt: new Date(now).toISOString(), codes};
  await writeNewPrivateJson(root, destination, batch, io);
  return {batch, destination};
}

export function parseActivationArguments(args) {
  const options = {}, allowed = new Set(['duration-days', 'count', 'output']);
  for (let index = 0; index < args.length; index++) {
    const name = args[index].startsWith('--') ? args[index].slice(2) : '';
    if (!allowed.has(name) || Object.hasOwn(options, name) || !args[index + 1] || args[index + 1].startsWith('--')) fail('INVALID_ACTIVATION_ARGUMENTS');
    options[name] = args[++index];
  }
  if (!/^[1-9]\d{0,4}$/.test(options['duration-days'] ?? '') || !/^[1-9]\d{0,2}$/.test(options.count ?? '') || !options.output) fail('INVALID_ACTIVATION_ARGUMENTS');
  return {durationDays: Number(options['duration-days']), count: Number(options.count), output: options.output};
}

export async function runActivationCodeCli(args, {root = repoRoot, writeLine = console.log} = {}) {
  if (args.length === 1 && args[0] === '--help') {
    writeLine('Offline administrator: --duration-days 1..65535 --count 1..100 --output tmp/private/NEW_FILE.json. Uses tmp/private/license-activation-key.pem and cloud/public-activation-key.json; no CloudBase login or code publication.');
    return;
  }
  const prepared = await generateActivationCodeBatch({root, ...parseActivationArguments(args)});
  writeLine(`Created ${prepared.batch.codes.length} activation codes: ${prepared.destination}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runActivationCodeCli(process.argv.slice(2)).catch(error => {
    const code = error instanceof ActivationAdminError ? error.code : ['INVALID_ACTIVATION_CODE', 'SERVICE_UNCONFIGURED', 'ENOENT', 'EACCES', 'EPERM'].includes(error.code) ? error.code : 'ACTIVATION_BATCH_FAILED';
    console.error(code); process.exitCode = 1;
  });
}
