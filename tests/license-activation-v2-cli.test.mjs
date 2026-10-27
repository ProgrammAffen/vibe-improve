import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {generateKeyPairSync, verify} from 'node:crypto';
import {join, resolve} from 'node:path';
import {generateActivationCodeBatch, parseActivationArguments, runActivationCodeCli} from '../scripts/license-generate-v2.mjs';
import {verifyActivationCode} from '../cloud/functions/license-api/activation-code-v2.mjs';

const now = Date.UTC(2026, 9, 20, 12, 34, 56);
async function fixture(t) {
  const base = resolve('tmp/checks/2026-10-20-license-replica');
  await fs.mkdir(base, {recursive: true});
  const root = await fs.mkdtemp(join(base, 'activation-cli-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  await fs.mkdir(join(root, 'tmp'), {mode: 0o700});
  await fs.mkdir(join(root, 'tmp/private'), {mode: 0o700});
  await fs.mkdir(join(root, 'cloud'), {mode: 0o755});
  const {privateKey, publicKey} = generateKeyPairSync('ed25519');
  const privateFile = join(root, 'tmp/private/license-activation-key.pem');
  const publicFile = join(root, 'cloud/public-activation-key.json');
  const trust = {schemaVersion: 2, algorithm: 'Ed25519', keyId: 'vi-activation-v2-synthetic', productId: 'vibe-improve', profileId: 1,
    publicKeyPem: publicKey.export({type: 'spki', format: 'pem'}).toString()};
  await fs.writeFile(privateFile, privateKey.export({type: 'pkcs8', format: 'pem'}), {mode: 0o600});
  await fs.writeFile(publicFile, JSON.stringify(trust), {mode: 0o644});
  const generate = options => generateActivationCodeBatch({root, durationDays: 7, count: 2, output: 'tmp/private/batches/codes.json', now, ...options});
  return {root, privateFile, publicFile, trust, publicKey, generate};
}
const rejectsCode = (promise, code) => assert.rejects(promise, error => error.code === code);
function frameFromCode(code) {
  const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  let number = 0n;
  for (const digit of code.replace(/^VI-/, '').replaceAll('-', '')) number = number * 31n + BigInt(alphabet.indexOf(digit));
  let hex = number.toString(16); if (hex.length % 2) hex = `0${hex}`;
  return Buffer.from(hex, 'hex');
}

test('offline administrator emits private, self-verifiable v2 batches without a database publication', async t => {
  const f = await fixture(t), result = await f.generate();
  const serialized = await fs.readFile(result.destination, 'utf8'), batch = JSON.parse(serialized);
  assert.equal(batch.schemaVersion, 2); assert.equal(batch.keyId, f.trust.keyId);
  assert.equal(batch.profileId, 1); assert.equal(batch.productId, 'vibe-improve');
  assert.equal(batch.durationDays, 7); assert.equal(batch.issuedAt, new Date(now).toISOString());
  assert.deepEqual(batch.features, ['app.access']); assert.equal(batch.tier, 'pro');
  assert.equal(Object.hasOwn(batch, 'maxDevices'), false);
  assert.equal((await fs.stat(result.destination)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(join(f.root, 'tmp/private/batches'))).mode & 0o777, 0o700);
  assert.equal((await fs.stat(result.destination)).nlink, 1);
  assert.equal(batch.codes.length, 2); assert.equal(new Set(batch.codes.map(item => item.code)).size, 2);
  for (const item of batch.codes) {
    assert.equal(item.code.length, 157); assert.match(item.code, /^VI-(?:[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-){30}[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);
    const checked = verifyActivationCode(item.code, f.trust.publicKeyPem, now);
    assert.equal(checked.durationDays, 7); assert.equal(checked.codeHash, item.codeHash); assert.equal(checked.payloadHash, item.payloadHash);
    const frame = frameFromCode(item.code), payload = frame.subarray(0, 13);
    assert.equal(frame.length, 77); assert.equal(payload[0], 0x21); assert.equal(payload.readUInt16BE(1), 7);
    assert.equal(payload.readUInt16BE(3), Math.floor((now - Date.UTC(2026, 0, 1)) / 86400_000));
    assert.equal(verify(null, Buffer.concat([Buffer.from('vibe-improve:activation:v2\0'), payload]), f.publicKey, frame.subarray(13)), true);
    assert.equal(verify(null, Buffer.concat([Buffer.from('vibe-learning:activation:v2\0'), payload]), f.publicKey, frame.subarray(13)), false);
  }
  assert.equal(serialized.includes('PRIVATE KEY'), false);
  assert.deepEqual(await fs.readdir(join(f.root, 'tmp/private/batches')), ['codes.json']);
});

test('issued signed codes reject tampering and a different public key', async t => {
  const f = await fixture(t), {batch} = await f.generate({count: 1});
  const code = batch.codes[0].code;
  const altered = code.slice(0, -1) + (code.endsWith('2') ? '3' : '2');
  assert.throws(() => verifyActivationCode(altered, f.trust.publicKeyPem, now), error => error.code === 'INVALID_ACTIVATION_CODE');
  const other = generateKeyPairSync('ed25519').publicKey.export({type: 'spki', format: 'pem'});
  assert.throws(() => verifyActivationCode(code, other, now), error => error.code === 'INVALID_ACTIVATION_CODE');
  assert.equal(verifyActivationCode(` ${code.toLowerCase()}\n`, f.trust.publicKeyPem, now).codeHash, batch.codes[0].codeHash);
});

test('unknown trust configuration and mismatched signing keys fail before writing a batch', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.publicFile, JSON.stringify({...f.trust, keyId: 'unknown-key'}));
  await rejectsCode(f.generate(), 'ACTIVATION_TRUST_INVALID');
  const other = generateKeyPairSync('ed25519').publicKey.export({type: 'spki', format: 'pem'}).toString();
  await fs.writeFile(f.publicFile, JSON.stringify({...f.trust, publicKeyPem: other}));
  await rejectsCode(f.generate(), 'ACTIVATION_KEY_MISMATCH');
  await fs.writeFile(f.publicFile, JSON.stringify({...f.trust, productId: 'another-product'}));
  await rejectsCode(f.generate(), 'ACTIVATION_TRUST_INVALID');
  await assert.rejects(fs.stat(join(f.root, 'tmp/private/batches/codes.json')), {code: 'ENOENT'});
});

test('only explicit whole-day duration, count and private output arguments are accepted', async t => {
  const f = await fixture(t);
  for (const args of [[], ['--duration-days', '7'], ['--duration-days', '1.5', '--count', '1', '--output', 'x'],
    ['--duration-days', '0', '--count', '1', '--output', 'x'], ['--duration-days', '7', '--count', '-1', '--output', 'x'],
    ['--duration-days', '7', '--count', '1', '--count', '2', '--output', 'x'],
    ['--duration-days', '7', '--count', '1', '--output', 'x', '--max-devices', '2']]) {
    assert.throws(() => parseActivationArguments(args), error => error.code === 'INVALID_ACTIVATION_ARGUMENTS');
  }
  for (const options of [{durationDays: 0}, {durationDays: 65536}, {durationDays: true}, {durationDays: 1.5}, {count: 0}, {count: 101}, {count: true}, {now: NaN}, {now: -1}]) {
    await rejectsCode(f.generate(options), 'INVALID_ACTIVATION_ARGUMENTS');
  }
  for (const output of ['tmp/codes.json', 'codes.json', 'tmp/private/../codes.json', 'tmp/private/codes.txt', '../codes.json']) {
    await rejectsCode(f.generate({output}), 'ACTIVATION_OUTPUT_MUST_BE_PRIVATE_JSON');
  }
  assert.deepEqual(await fs.readdir(join(f.root, 'tmp/private')), ['license-activation-key.pem']);
});

test('documented duration boundaries are accepted', async t => {
  const f = await fixture(t);
  for (const durationDays of [1, 65535]) {
    const {batch} = await f.generate({durationDays, count: 1, output: `tmp/private/duration-${durationDays}.json`});
    assert.equal(verifyActivationCode(batch.codes[0].code, f.trust.publicKeyPem, now).durationDays, durationDays);
  }
});

test('private keys and output directories require owner-only permissions', async t => {
  const f = await fixture(t);
  await fs.chmod(f.privateFile, 0o644);
  await rejectsCode(f.generate(), 'ACTIVATION_UNSAFE_KEY_FILE');
  await fs.chmod(f.privateFile, 0o600);
  await fs.chmod(join(f.root, 'tmp/private'), 0o755);
  await rejectsCode(f.generate(), 'ACTIVATION_UNSAFE_DIRECTORY');
  await fs.chmod(join(f.root, 'tmp/private'), 0o700);
  await fs.mkdir(join(f.root, 'tmp/private/batches'), {mode: 0o755});
  await rejectsCode(f.generate(), 'ACTIVATION_UNSAFE_DIRECTORY');
});

test('a completed batch is immutable and repeated output cannot consume or replace it', async t => {
  const f = await fixture(t), first = await f.generate();
  const original = await fs.readFile(first.destination);
  await rejectsCode(f.generate({count: 1}), 'ACTIVATION_OUTPUT_EXISTS');
  assert.deepEqual(await fs.readFile(first.destination), original);
  assert.deepEqual(await fs.readdir(join(f.root, 'tmp/private/batches')), ['codes.json']);
});

test('symlinks and hard-linked key files are refused without following output redirection', async t => {
  const f = await fixture(t);
  const outside = join(f.root, 'other'); await fs.mkdir(outside);
  await fs.symlink(outside, join(f.root, 'tmp/private/redirect'));
  await rejectsCode(f.generate({output: 'tmp/private/redirect/codes.json'}), 'ACTIVATION_UNSAFE_DIRECTORY');
  assert.deepEqual(await fs.readdir(outside), []);
  await fs.writeFile(join(outside, 'existing.json'), 'synthetic-original');
  await fs.symlink(join(outside, 'existing.json'), join(f.root, 'tmp/private/existing.json'));
  await rejectsCode(f.generate({output: 'tmp/private/existing.json'}), 'ACTIVATION_OUTPUT_EXISTS');
  assert.equal(await fs.readFile(join(outside, 'existing.json'), 'utf8'), 'synthetic-original');
  await fs.link(f.privateFile, join(f.root, 'tmp/private/key-hardlink.pem'));
  await rejectsCode(f.generate(), 'ACTIVATION_UNSAFE_KEY_FILE');
});

test('atomic publication failure removes its temporary file and cannot expose a partial batch', async t => {
  const f = await fixture(t);
  const failingIO = {...fs, link: async () => {throw new Error('SYNTHETIC_PUBLICATION_FAILURE');}};
  await assert.rejects(f.generate({io: failingIO}), /SYNTHETIC_PUBLICATION_FAILURE/);
  assert.deepEqual(await fs.readdir(join(f.root, 'tmp/private/batches')), []);
});

test('file fsync failure leaves no published code file or temporary plaintext', async t => {
  const f = await fixture(t);
  const failingIO = {...fs, open: async (path, ...options) => {
    const file = await fs.open(path, ...options);
    if (!path.endsWith('.tmp')) return file;
    return {chmod: file.chmod.bind(file), writeFile: file.writeFile.bind(file), close: file.close.bind(file),
      sync: async () => {throw new Error('SYNTHETIC_FSYNC_FAILURE');}};
  }};
  await assert.rejects(f.generate({io: failingIO}), /SYNTHETIC_FSYNC_FAILURE/);
  assert.deepEqual(await fs.readdir(join(f.root, 'tmp/private/batches')), []);
});

test('concurrent publications cannot replace one another after the existence check', async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled([f.generate({count: 1}), f.generate({count: 2})]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(results.find(item => item.status === 'rejected').reason.code, 'ACTIVATION_OUTPUT_EXISTS');
  const winner = results.find(item => item.status === 'fulfilled').value;
  assert.deepEqual(JSON.parse(await fs.readFile(winner.destination, 'utf8')), winner.batch);
  assert.equal((await fs.stat(winner.destination)).nlink, 1);
  assert.deepEqual(await fs.readdir(join(f.root, 'tmp/private/batches')), ['codes.json']);
});

test('a symlinked private key is refused without reading its contents', async t => {
  const f = await fixture(t), original = join(f.root, 'tmp/private/original.pem');
  await fs.rename(f.privateFile, original); await fs.symlink(original, f.privateFile);
  await assert.rejects(f.generate(), error => ['ELOOP', 'EMLINK'].includes(error.code));
  await assert.rejects(fs.stat(join(f.root, 'tmp/private/batches/codes.json')), {code: 'ENOENT'});
});

test('CLI prints only the output location and count, never codes or signing material', async t => {
  const f = await fixture(t), lines = [];
  await runActivationCodeCli(['--duration-days', '7', '--count', '2', '--output', 'tmp/private/cli.json'], {root: f.root, writeLine: line => lines.push(line)});
  assert.equal(lines.length, 1); assert.equal(lines[0], `Created 2 activation codes: ${join(f.root, 'tmp/private/cli.json')}`);
  const batch = JSON.parse(await fs.readFile(join(f.root, 'tmp/private/cli.json'), 'utf8'));
  for (const item of batch.codes) assert.equal(lines.join('\n').includes(item.code), false);
  assert.equal(lines.join('\n').includes('PRIVATE KEY'), false);
  const help = []; await runActivationCodeCli(['--help'], {root: f.root, writeLine: line => help.push(line)});
  assert.equal(help.length, 1); assert.match(help[0], /no CloudBase login/);
});
