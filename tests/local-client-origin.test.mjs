import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
test('CloudBase frontend publishing stops before invoking the CLI', () => {
  const result = spawnSync(process.execPath, ['scripts/deploy-cloudbase.mjs', 'hosting'], {cwd: root, encoding: 'utf8'});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CLOUDBASE_BACKEND_ONLY/);
});

test('desktop navigation and native bridge accept only the current local app origin', {skip: process.platform !== 'darwin', timeout: 60_000}, async () => {
  const base = join(root, 'tmp/checks/local-client-origin');
  await mkdir(base, {recursive: true});
  const run = await mkdtemp(join(base, 'run-'));
  const main = join(run, 'main.swift');
  await writeFile(main, `import Foundation
let origin = LocalClientOrigin(port: 43129)
precondition(origin.startURL.absoluteString == "http://127.0.0.1:43129/vibe-improve/")
for address in ["http://127.0.0.1:43129/vibe-improve/", "http://127.0.0.1:43129/vibe-improve/#/settings", "http://127.0.0.1:43129/vibe-improve/assets/test.js"] {
    precondition(origin.permits(URL(string: address)!))
}
for address in ["https://127.0.0.1:43129/vibe-improve/", "http://127.0.0.1:43128/vibe-improve/", "http://localhost:43129/vibe-improve/", "http://127.0.0.1:43129/other/", "http://127.0.0.1:43129/vibe-improve-other/", "http://user@127.0.0.1:43129/vibe-improve/", "https://one-person-company-7dao3979fd72e-1302619113.tcloudbaseapp.com/vibe-improve/", "file:///vibe-improve/index.html"] {
    precondition(!origin.permits(URL(string: address)!))
}
precondition(!LocalClientOrigin(port: 0).permits(URL(string: "http://127.0.0.1:0/vibe-improve/")!))
print("local origin assertions passed")
`);
  const env = {...process.env, CLANG_MODULE_CACHE_PATH: join(root, 'tmp/cache/clang'), SWIFT_MODULECACHE_PATH: join(root, 'tmp/cache/swift')};
  const binary = join(run, 'origin-test');
  const compile = spawnSync('/usr/bin/swiftc', ['-module-cache-path', join(root, 'tmp/cache/swift'), join(root, 'apps/macos/LocalClientOrigin.swift'), main, '-o', binary], {cwd: root, env, encoding: 'utf8'});
  assert.equal(compile.status, 0, compile.stderr);
  const result = spawnSync(binary, [], {cwd: root, env, encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /assertions passed/);
});
