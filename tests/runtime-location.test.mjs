import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

const base = resolve('tmp/checks/runtime-location-tests');
let compiled;
async function executable() {
  if (!compiled) compiled = (async () => {
    await fs.mkdir(base, {recursive: true});
    const source = join(base, 'main.swift'), binary = join(base, 'prepare');
    await fs.writeFile(source, `import Foundation\nlet args=CommandLine.arguments\ndo { let runtime=try RuntimeLocation.prepare(applicationSupport:URL(fileURLWithPath:args[1]),legacy:args.dropFirst(2).map{URL(fileURLWithPath:$0)});print(runtime.url.path) } catch { print("MIGRATION_FAILED");exit(2) }\n`);
    const result = spawnSync('/usr/bin/swiftc', ['-module-cache-path', 'tmp/cache/swift', 'apps/macos/RuntimeDirectory.swift', 'apps/macos/RuntimeLocation.swift', source, '-o', binary], {encoding: 'utf8', timeout: 120_000});
    assert.equal(result.status, 0, result.stderr);
    return binary;
  })();
  return compiled;
}
async function fixture(t) {
  await fs.mkdir(base, {recursive: true});
  const root = await fs.mkdtemp(join(base, 'case-')), support = join(root, 'Library/Application Support'), legacy = join(root, 'old/Vibe Improve Runtime'), target = join(support, 'Vibe Improve');
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const binary = await executable();
  const run = (...sources) => spawnSync(binary, [support, ...sources], {encoding: 'utf8', timeout: 30_000});
  async function prepare({session = true} = {}) {
    for (const name of ['auth', 'projects', 'agents/codebuddy/cli-2.177.0/node_modules/.bin', 'logs']) await fs.mkdir(join(legacy, name), {recursive: true, mode: 0o700});
    await fs.writeFile(join(legacy, 'device.json'), 'SYNTHETIC_DEVICE', {mode: 0o600});
    await fs.writeFile(join(legacy, 'preferences.json'), 'SYNTHETIC_PREFERENCES', {mode: 0o600});
    await fs.writeFile(join(legacy, 'projects/index.json'), 'SYNTHETIC_PROJECTS', {mode: 0o600});
    await fs.writeFile(join(legacy, 'agents/choices.json'), 'SYNTHETIC_SELECTION', {mode: 0o600});
    await fs.writeFile(join(legacy, 'logs/native.ndjson'), 'SYNTHETIC_LEGACY_LOG', {mode: 0o600});
    await fs.writeFile(join(legacy, 'local-server.json'), 'SYNTHETIC_STALE_PORT', {mode: 0o600});
    await fs.writeFile(join(legacy, 'auth/session.lock'), '', {mode: 0o600});
    if (session) {
      await fs.writeFile(join(legacy, 'auth/session.json'), 'SYNTHETIC_CIPHERTEXT', {mode: 0o600});
      await fs.writeFile(join(legacy, 'auth/session.key'), Buffer.alloc(32, 0x25), {mode: 0o600});
    }
    const cli = join(legacy, 'agents/codebuddy/cli-2.177.0/node_modules/cli.js');
    await fs.writeFile(cli, '#!/usr/bin/env node\nprocess.stdout.write("SYNTHETIC");', {mode: 0o755});
    await fs.symlink('../cli.js', join(legacy, 'agents/codebuddy/cli-2.177.0/node_modules/.bin/codebuddy'));
  }
  return {root, support, legacy, target, run, prepare};
}
const options = {skip: process.platform !== 'darwin', timeout: 150_000};

test('native migration atomically preserves identity, encrypted session, projects, CLI links and logs without carrying stale ports or locks', options, async t => {
  const f = await fixture(t); await f.prepare(); const result = f.run(f.legacy);
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), f.target);
  for (const name of ['device.json', 'preferences.json', 'auth/session.json', 'auth/session.key', 'projects/index.json', 'agents/choices.json', 'logs/native.ndjson']) {
    assert.deepEqual(await fs.readFile(join(f.target, name)), await fs.readFile(join(f.legacy, name)));
    assert.equal((await fs.stat(join(f.target, name))).mode & 0o777, 0o600);
  }
  assert.equal(await fs.readlink(join(f.target, 'agents/codebuddy/cli-2.177.0/node_modules/.bin/codebuddy')), '../cli.js');
  assert.equal((await fs.stat(join(f.target, 'agents/codebuddy/cli-2.177.0/node_modules/cli.js'))).mode & 0o777, 0o700);
  await assert.rejects(fs.stat(join(f.target, 'local-server.json')), {code: 'ENOENT'});
  await assert.rejects(fs.stat(join(f.target, 'auth/session.lock')), {code: 'ENOENT'});
  assert.equal((await fs.stat(f.target)).mode & 0o777, 0o700);
  assert.deepEqual(await fs.readdir(f.support), ['Vibe Improve']);
});

test('the standard directory wins after relocation or rebuild and does not inspect a conflicting legacy identity', options, async t => {
  const f = await fixture(t); await f.prepare(); assert.equal(f.run(f.legacy).status, 0);
  await fs.writeFile(join(f.target, 'device.json'), 'SYNTHETIC_CURRENT_DEVICE');
  await fs.unlink(join(f.legacy, 'device.json')); await fs.symlink('/does-not-exist', join(f.legacy, 'device.json'));
  assert.equal(f.run(f.legacy, join(f.root, 'another-install')).status, 0);
  assert.equal(await fs.readFile(join(f.target, 'device.json'), 'utf8'), 'SYNTHETIC_CURRENT_DEVICE');
  assert.equal(await fs.readFile(join(f.target, 'projects/index.json'), 'utf8'), 'SYNTHETIC_PROJECTS');
});

test('an empty or log-only standard directory adopts legacy data and archives the earlier logs separately', options, async t => {
  for (const logs of [false, true]) {
    const f = await fixture(t); await f.prepare(); await fs.mkdir(f.target, {recursive: true});
    if (logs) {await fs.mkdir(join(f.target, 'logs')); await fs.writeFile(join(f.target, 'logs/native.ndjson'), 'SYNTHETIC_EARLY_LOG');}
    assert.equal(f.run(f.legacy).status, 0);
    assert.equal(await fs.readFile(join(f.target, 'device.json'), 'utf8'), 'SYNTHETIC_DEVICE');
    if (logs) assert.equal(await fs.readFile(join(f.target, 'migration-backup/logs/native.ndjson'), 'utf8'), 'SYNTHETIC_EARLY_LOG');
    assert.deepEqual(await fs.readdir(f.support), ['Vibe Improve']);
  }
});

test('a fresh installation creates only its stable folder and repeated starts reuse it', options, async t => {
  const f = await fixture(t); assert.equal(f.run().status, 0); const before = await fs.stat(f.target);
  assert.equal(f.run(join(f.root, 'missing-app')).status, 0);
  assert.equal((await fs.stat(f.target)).ino, before.ino);
  assert.deepEqual(await fs.readdir(f.support), ['Vibe Improve']);
});

test('incomplete or invalid session pairs fail without publishing a partial runtime or changing originals', options, async t => {
  for (const kind of ['missing-key', 'missing-session', 'short-key', 'missing-identity']) {
    const f = await fixture(t); await f.prepare();
    if (kind === 'missing-key') await fs.unlink(join(f.legacy, 'auth/session.key'));
    if (kind === 'missing-session') await fs.unlink(join(f.legacy, 'auth/session.json'));
    if (kind === 'short-key') await fs.writeFile(join(f.legacy, 'auth/session.key'), Buffer.alloc(31));
    if (kind === 'missing-identity') {await fs.unlink(join(f.legacy, 'device.json')); await fs.unlink(join(f.legacy, 'preferences.json'));}
    assert.equal(f.run(f.legacy).status, 2);
    await assert.rejects(fs.lstat(f.target), {code: 'ENOENT'});
    assert.deepEqual(await fs.readdir(f.support), []);
    assert.equal(await fs.readFile(join(f.legacy, 'projects/index.json'), 'utf8'), 'SYNTHETIC_PROJECTS');
  }
});

test('a damaged standard runtime with session data but no identity is retained and blocks generating another identity', options, async t => {
  const f = await fixture(t); await f.prepare(); await fs.mkdir(join(f.target, 'auth'), {recursive: true});
  await fs.writeFile(join(f.target, 'auth/session.json'), 'SYNTHETIC_DAMAGED');
  assert.equal(f.run(f.legacy).status, 2);
  assert.deepEqual(await fs.readdir(f.target), ['auth']);
  assert.equal(await fs.readFile(join(f.target, 'auth/session.json'), 'utf8'), 'SYNTHETIC_DAMAGED');
});

test('redirected source/destination, external CLI links, hardlinks and oversized files are refused with originals retained', options, async t => {
  for (const kind of ['source-link', 'target-link', 'external-link', 'hardlink', 'oversize']) {
    const f = await fixture(t); await f.prepare();
    if (kind === 'source-link') {await fs.rename(f.legacy, join(f.root, 'original')); await fs.symlink(join(f.root, 'original'), f.legacy);}
    if (kind === 'target-link') {await fs.mkdir(f.support, {recursive: true}); await fs.symlink(f.legacy, f.target);}
    if (kind === 'external-link') await fs.symlink('/etc/passwd', join(f.legacy, 'agents/escape'));
    if (kind === 'hardlink') await fs.link(join(f.legacy, 'device.json'), join(f.root, 'device-link'));
    if (kind === 'oversize') {const fd=await fs.open(join(f.legacy, 'agents/oversize'),'w');await fd.truncate(1_073_741_825);await fd.close();}
    assert.equal(f.run(f.legacy).status, 2, kind);
    if (kind !== 'target-link') await assert.rejects(fs.lstat(f.target), {code: 'ENOENT'});
    assert.equal((await fs.readdir(f.support)).some(name=>name.startsWith('.vibe-improve-migrate-')), false);
  }
});

test('preferences-only legacy identity must be valid before adopting its encrypted session', options, async t => {
  for (const valid of [false, true]) {
    const f = await fixture(t); await f.prepare(); await fs.unlink(join(f.legacy, 'device.json'));
    await fs.writeFile(join(f.legacy, 'preferences.json'), JSON.stringify({deviceId:valid?'dev_synthetic_installation_0001':''}));
    const result=f.run(f.legacy);
    assert.equal(result.status, valid?0:2);
    if (valid) assert.deepEqual(await fs.readFile(join(f.target,'auth/session.json')),await fs.readFile(join(f.legacy,'auth/session.json')));
    else await assert.rejects(fs.lstat(f.target),{code:'ENOENT'});
  }
});
