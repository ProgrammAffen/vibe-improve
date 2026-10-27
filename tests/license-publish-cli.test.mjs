import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareCodeBatch } from '../scripts/license-create-codes.mjs';
import { publishPreparedBatchUsingCli } from '../scripts/license-publish-cli.mjs';
import { atomicWritePrivateJson } from '../scripts/private-json.mjs';
import { sha256 } from '../cloud/functions/license-api/service.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
async function fixture(fn) {
  const base = join(root, 'tmp', 'checks');
  await fs.mkdir(base, { recursive: true, mode: 0o700 });
  const directory = await fs.mkdtemp(join(base, 'license-publication-test-'));
  try { await fn(directory); } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
async function batch(directory, count = 2) {
  return prepareCodeBatch({ output: relative(root, join(directory, 'raw.json')), count, productId: 'vibe-improve',
    grant: { maxDevices: 2, features: ['app.access'], expiresAt: new Date(Date.now() + 86400_000).toISOString() } });
}

test('CLI partial publication failure preserves the only raw-code file and writes a hash-only receipt', async () => fixture(async directory => {
  const prepared = await batch(directory);
  const original = await fs.readFile(prepared.destination);
  const originalBatch = JSON.stringify(prepared.batch);
  let calls = 0;
  await assert.rejects(publishPreparedBatchUsingCli(prepared, { publish: async ({ code }) => {
    if (++calls === 2) throw new Error('CLOUDBASE_NETWORK_FAILED');
    return { codeHash: sha256(code), created: true, verified: true };
  } }), /CLOUDBASE_NETWORK_FAILED/);
  assert.deepEqual(await fs.readFile(prepared.destination), original);
  assert.equal(JSON.stringify(prepared.batch), originalBatch);
  const receiptText = await fs.readFile(join(directory, 'raw.publication.json'), 'utf8');
  const receipt = JSON.parse(receiptText);
  assert.deepEqual(receipt.codes.map(row => row.status), ['verified', 'unknown']);
  assert.equal(receipt.codes[0].created, true);
  assert.equal(receipt.codes[0].verified, true);
  assert.equal(receipt.codes[1].verified, false);
  for (const item of prepared.batch.codes) assert.equal(receiptText.includes(item.code), false);
  assert.equal((await fs.stat(join(directory, 'raw.publication.json'))).mode & 0o777, 0o600);
}));

test('credential rename failure leaves the previous private file complete and removes the temporary copy', async () => fixture(async directory => {
  const file = join(directory, 'credentials.json');
  await atomicWritePrivateJson(file, { password: 'previous-synthetic-value', revision: 1 });
  const original = await fs.readFile(file);
  let attemptedRename = false;
  const failingIO = { ...fs, async rename() { attemptedRename = true; throw new Error('SIMULATED_RENAME_FAILURE'); } };
  await assert.rejects(atomicWritePrivateJson(file, { password: 'next-synthetic-value', revision: 2 }, failingIO), /SIMULATED_RENAME_FAILURE/);
  assert.equal(attemptedRename, true);
  assert.deepEqual(await fs.readFile(file), original);
  assert.deepEqual(await fs.readdir(directory), ['credentials.json']);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
}));

test('receipt persistence failure before publication cannot truncate raw codes or start a cloud write', async () => fixture(async directory => {
  const prepared = await batch(directory, 1);
  const original = await fs.readFile(prepared.destination);
  let cloudCalled = false;
  await assert.rejects(publishPreparedBatchUsingCli(prepared, {
    publish: async () => { cloudCalled = true; throw new Error('UNEXPECTED_CLOUD_WRITE'); },
    writeReceipt: async (file, value) => atomicWritePrivateJson(file, value, { ...fs, async rename() { throw new Error('SIMULATED_DISK_FAILURE'); } }),
  }), /SIMULATED_DISK_FAILURE/);
  assert.equal(cloudCalled, false);
  assert.deepEqual(await fs.readFile(prepared.destination), original);
  assert.deepEqual(await fs.readdir(directory), ['raw.json']);
}));
