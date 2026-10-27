import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {migrateMacRuntime} from '../scripts/migrate-mac-runtime.mjs';
import {publishMacApp} from '../scripts/publish-mac-app.mjs';

async function fixture(t) {
  const base = resolve('tmp/checks/2026-10-20-license-replica'); await fs.mkdir(base, {recursive: true});
  const root = await fs.mkdtemp(join(base, 'runtime-migration-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const source = join(root, 'tmp/build/Vibe Improve Runtime'), destination = join(root, 'output/Vibe Improve Runtime');
  const preferences = Buffer.from(JSON.stringify({deviceId: 'dev_synthetic_installation_0001', preferences: {language: 'zh-CN'}}));
  const device = Buffer.from(JSON.stringify({version: 1, device_id: 'dev_synthetic_installation_0001', created_at: '2026-10-20T00:00:00Z'}));
  const session = Buffer.from('SYNTHETIC_ENCRYPTED_SESSION_BYTES'), key = Buffer.alloc(32, 0x24);
  async function prepare(path = source, {auth = true, identity = true, deviceFile = true} = {}) {
    await fs.mkdir(path, {recursive: true, mode: 0o700});
    if (identity) await fs.writeFile(join(path, 'preferences.json'), preferences, {mode: 0o600});
    if (deviceFile) await fs.writeFile(join(path, 'device.json'), device, {mode: 0o600});
    if (auth) {
      await fs.mkdir(join(path, 'auth'), {mode: 0o700});
      await fs.writeFile(join(path, 'auth/session.json'), session, {mode: 0o600});
      await fs.writeFile(join(path, 'auth/session.key'), key, {mode: 0o600});
    }
  }
  return {root, source, destination, preferences, device, session, key, prepare};
}
const rejectsCode = (promise, code) => assert.rejects(promise, error => error.code === code);

test('first migration preserves installation and session bytes, secures the copy, and retains its source', async t => {
  const f = await fixture(t); await f.prepare();
  const result = await migrateMacRuntime(f.root);
  assert.equal(result.status, 'migrated'); assert.equal(result.source, f.source); assert.equal(result.destination, f.destination);
  for (const [name, bytes] of [['preferences.json', f.preferences], ['device.json', f.device], ['auth/session.json', f.session], ['auth/session.key', f.key]]) {
    assert.deepEqual(await fs.readFile(join(f.destination, name)), bytes);
    assert.deepEqual(await fs.readFile(join(f.source, name)), bytes);
    const info = await fs.stat(join(f.destination, name)); assert.equal(info.mode & 0o777, 0o600); assert.equal(info.nlink, 1);
  }
  for (const path of [f.destination, join(f.destination, 'auth')]) assert.equal((await fs.stat(path)).mode & 0o777, 0o700);
  assert.deepEqual(await fs.readdir(join(f.root, 'output')), ['Vibe Improve Runtime']);
});

test('an existing output runtime is preserved without inspecting an unsafe legacy source', async t => {
  const f = await fixture(t); await f.prepare();
  await fs.mkdir(f.destination, {recursive: true, mode: 0o700});
  await fs.writeFile(join(f.destination, 'preferences.json'), 'SYNTHETIC_CURRENT_IDENTITY', {mode: 0o600});
  const before = await fs.stat(f.destination), current = await fs.readFile(join(f.destination, 'preferences.json'));
  await fs.unlink(join(f.source, 'preferences.json')); await fs.symlink('/does-not-exist', join(f.source, 'preferences.json'));
  assert.equal((await migrateMacRuntime(f.root)).status, 'preserved');
  assert.deepEqual(await fs.readFile(join(f.destination, 'preferences.json')), current);
  assert.equal((await fs.stat(f.destination)).ino, before.ino);
  assert.deepEqual(await fs.readdir(f.destination), ['preferences.json']);
});

test('an existing empty output runtime is never replaced', async t => {
  const f = await fixture(t); await f.prepare(); await fs.mkdir(f.destination, {recursive: true});
  const before = await fs.stat(f.destination);
  assert.equal((await migrateMacRuntime(f.root)).status, 'preserved');
  assert.equal((await fs.stat(f.destination)).ino, before.ino); assert.deepEqual(await fs.readdir(f.destination), []);
});

test('no legacy source creates neither an empty runtime nor an output directory', async t => {
  const f = await fixture(t);
  assert.equal((await migrateMacRuntime(f.root)).status, 'not-needed');
  await assert.rejects(fs.lstat(join(f.root, 'output')), {code: 'ENOENT'});
});

test('logs, local server records, locks and unknown files never enter the new runtime', async t => {
  const f = await fixture(t); await f.prepare();
  await fs.mkdir(join(f.source, 'logs')); await fs.writeFile(join(f.source, 'logs/native.ndjson'), 'SYNTHETIC_LOG');
  for (const name of ['local-server.json', 'session.lock', 'unknown.txt', 'certificate.json']) await fs.writeFile(join(f.source, name), 'SYNTHETIC_UNKNOWN');
  await fs.writeFile(join(f.source, 'auth/session.lock'), 'SYNTHETIC_LOCK');
  await fs.symlink('/does-not-exist', join(f.source, 'ignored-link'));
  await migrateMacRuntime(f.root);
  assert.deepEqual((await fs.readdir(f.destination)).sort(), ['auth', 'device.json', 'preferences.json']);
  assert.deepEqual((await fs.readdir(join(f.destination, 'auth'))).sort(), ['session.json', 'session.key']);
  assert.equal(await fs.readFile(join(f.source, 'logs/native.ndjson'), 'utf8'), 'SYNTHETIC_LOG');
});

test('fixed fallback sources migrate in priority order and empty sources are skipped', async t => {
  const f = await fixture(t), second = join(f.root, 'tmp/build/macos/Vibe Improve Runtime'), third = join(f.root, 'tmp/build/runtime');
  await fs.mkdir(f.source, {recursive: true}); await fs.writeFile(join(f.source, 'ignored.txt'), 'SYNTHETIC_UNKNOWN');
  await f.prepare(second, {auth: false}); await f.prepare(third, {auth: false});
  const result = await migrateMacRuntime(f.root);
  assert.equal(result.source, second); assert.equal(result.status, 'migrated');
  assert.deepEqual((await fs.readdir(f.destination)).sort(), ['device.json', 'preferences.json']);
});

test('the original runtime/preferences.json fallback preserves legacy identity without an auth folder', async t => {
  const f = await fixture(t), third = join(f.root, 'tmp/build/runtime'); await f.prepare(third, {auth: false, deviceFile: false});
  const result = await migrateMacRuntime(f.root);
  assert.equal(result.source, third); assert.deepEqual(await fs.readFile(join(f.destination, 'preferences.json')), f.preferences);
  assert.deepEqual(await fs.readdir(f.destination), ['preferences.json']);
});

test('symlinked source files, source directories, auth directories and destinations are refused', async t => {
  for (const kind of ['file', 'source', 'auth', 'destination']) {
    const f = await fixture(t); await f.prepare(); const other = join(f.root, 'other'); await fs.mkdir(other);
    if (kind === 'file') {await fs.unlink(join(f.source, 'preferences.json')); await fs.symlink(join(other, 'preferences.json'), join(f.source, 'preferences.json'));}
    if (kind === 'source') {await fs.rename(f.source, join(f.root, 'original')); await fs.symlink(join(f.root, 'original'), f.source);}
    if (kind === 'auth') {await fs.rename(join(f.source, 'auth'), join(f.root, 'original-auth')); await fs.symlink(join(f.root, 'original-auth'), join(f.source, 'auth'));}
    if (kind === 'destination') {await fs.mkdir(join(f.root, 'output')); await fs.symlink(other, f.destination);}
    await rejectsCode(migrateMacRuntime(f.root), kind === 'file' ? 'MAC_RUNTIME_UNSAFE_FILE' : 'MAC_RUNTIME_UNSAFE_DIRECTORY');
    assert.deepEqual(await fs.readdir(other), []);
  }
});

test('hard-linked and oversized whitelisted source files are refused before creating output', async t => {
  for (const kind of ['hardlink', 'oversize']) {
    const f = await fixture(t); await f.prepare();
    if (kind === 'hardlink') await fs.link(join(f.source, 'preferences.json'), join(f.root, 'extra-link'));
    else await fs.writeFile(join(f.source, 'preferences.json'), Buffer.alloc(65537));
    await rejectsCode(migrateMacRuntime(f.root), 'MAC_RUNTIME_UNSAFE_FILE');
    await assert.rejects(fs.lstat(join(f.root, 'output')), {code: 'ENOENT'});
  }
});

test('foreign-owned files are refused without copying their body', async t => {
  const f = await fixture(t); await f.prepare(); let read = false;
  const io = {...fs, lstat: async path => {
    const info = await fs.lstat(path);
    return path === join(f.source, 'preferences.json') ? new Proxy(info, {get: (target, key) => key === 'uid' ? info.uid + 1 : Reflect.get(target, key)}) : info;
  }, open: async (...args) => {read = true; return fs.open(...args);}};
  await rejectsCode(migrateMacRuntime(f.root, {io}), 'MAC_RUNTIME_UNSAFE_FILE'); assert.equal(read, false);
});

test('session and key must exist together, retain valid key length and have an identity', async t => {
  for (const kind of ['missing-key', 'missing-session', 'short-key', 'missing-identity']) {
    const f = await fixture(t); await f.prepare();
    if (kind === 'missing-key') await fs.unlink(join(f.source, 'auth/session.key'));
    if (kind === 'missing-session') await fs.unlink(join(f.source, 'auth/session.json'));
    if (kind === 'short-key') await fs.writeFile(join(f.source, 'auth/session.key'), Buffer.alloc(31));
    if (kind === 'missing-identity') {await fs.unlink(join(f.source, 'preferences.json')); await fs.unlink(join(f.source, 'device.json'));}
    await rejectsCode(migrateMacRuntime(f.root), kind.startsWith('missing-') && kind !== 'missing-identity' ? 'MAC_RUNTIME_SESSION_INCOMPLETE' : kind === 'short-key' ? 'MAC_RUNTIME_SESSION_INVALID' : 'MAC_RUNTIME_IDENTITY_MISSING');
    await assert.rejects(fs.lstat(join(f.root, 'output')), {code: 'ENOENT'});
  }
});

test('failed atomic rename removes only its empty reservation and leaves all original data', async t => {
  const f = await fixture(t); await f.prepare();
  await assert.rejects(migrateMacRuntime(f.root, {io: {...fs, rename: async () => {throw new Error('SYNTHETIC_RENAME_FAILURE');}}}), /SYNTHETIC_RENAME_FAILURE/);
  assert.deepEqual(await fs.readdir(join(f.root, 'output')), []);
  assert.deepEqual(await fs.readFile(join(f.source, 'preferences.json')), f.preferences);
  assert.deepEqual(await fs.readFile(join(f.source, 'auth/session.json')), f.session);
});

test('a destination created while staging is preserved, including an empty directory', async t => {
  const f = await fixture(t); await f.prepare(); let created;
  const io = {...fs, mkdir: async (path, options) => {
    if (path === f.destination) {
      await fs.mkdir(path, options); created = await fs.stat(path);
      throw Object.assign(new Error('SYNTHETIC_ALREADY_CREATED'), {code: 'EEXIST'});
    }
    return fs.mkdir(path, options);
  }};
  assert.equal((await migrateMacRuntime(f.root, {io})).status, 'preserved');
  assert.equal((await fs.stat(f.destination)).ino, created.ino); assert.deepEqual(await fs.readdir(f.destination), []);
  assert.deepEqual(await fs.readdir(join(f.root, 'output')), ['Vibe Improve Runtime']);
});

test('an application publication failure cannot remove migrated or original runtime data', async t => {
  const f = await fixture(t); await f.prepare(); await fs.mkdir(join(f.root, 'tmp/build/macos'), {recursive: true});
  assert.equal((await migrateMacRuntime(f.root)).status, 'migrated');
  await assert.rejects(publishMacApp(f.root, join(f.root, 'tmp/build/macos/absent.app')), {code: 'ENOENT'});
  assert.deepEqual(await fs.readFile(join(f.destination, 'preferences.json')), f.preferences);
  assert.deepEqual(await fs.readFile(join(f.source, 'preferences.json')), f.preferences);
  assert.deepEqual(await fs.readFile(join(f.destination, 'auth/session.json')), f.session);
});
