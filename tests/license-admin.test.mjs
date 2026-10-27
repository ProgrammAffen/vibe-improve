import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, symlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { prepareCodeBatch, publishCodeBatch } from '../scripts/license-create-codes.mjs';
import { sha256, validateGrant } from '../cloud/functions/license-api/service.mjs';

const grant = { maxDevices: 2, features: ['learning.ai'], expiresAt: '2099-01-01T00:00:00.000Z' };
async function setup(t) {
  const base = resolve('tmp/work/2026-10-18-app-build');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'license-tests-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test('admin output is new, private, immutable and database never receives raw code', async t => {
  const root = await setup(t);
  const prepared = await prepareCodeBatch({ root, output: 'tmp/private/codes.json', count: 2, productId: 'test-product', grant });
  const original = await readFile(prepared.destination, 'utf8');
  assert.equal((await stat(prepared.destination)).mode & 0o777, 0o600);
  const records = new Map();
  const repo = { transaction: async fn => fn({ get: async (c, id) => records.get(`${c}/${id}`) ?? null, put: async (c, id, row) => {
    assert.equal(await readFile(prepared.destination, 'utf8'), original);
    records.set(`${c}/${id}`, row);
  } }) };
  await publishCodeBatch(repo, prepared);
  assert.equal(records.size, 2);
  for (const item of prepared.batch.codes) {
    assert.equal(item.codeHash, sha256(item.code));
    assert.ok(!JSON.stringify([...records]).includes(item.code));
  }
  assert.equal(await readFile(prepared.destination, 'utf8'), original);
  await assert.rejects(prepareCodeBatch({ root, output: 'tmp/private/codes.json', count: 1, productId: 'test-product', grant }), e => e.code === 'EEXIST');
});
test('admin output rejects outside tmp and symlink parent', async t => {
  const root = await setup(t);
  await assert.rejects(prepareCodeBatch({ root, output: 'not-tmp.json', count: 1, productId: 'test-product', grant }), e => e.code === 'OUTPUT_MUST_BE_TMP_JSON');
  await mkdir(join(root, 'tmp')); await mkdir(join(root, 'other'));
  await symlink(join(root, 'other'), join(root, 'tmp', 'escape'));
  await assert.rejects(prepareCodeBatch({ root, output: 'tmp/escape/codes.json', count: 1, productId: 'test-product', grant }), e => e.code === 'UNSAFE_OUTPUT_PATH');
});
test('partial or unknown cloud result never deletes the only raw code file', async t => {
  const root = await setup(t);
  const prepared = await prepareCodeBatch({ root, output: 'tmp/codes.json', count: 1, productId: 'test-product', grant });
  const original = await readFile(prepared.destination, 'utf8');
  await assert.rejects(publishCodeBatch({ transaction: async () => { throw new Error('unknown network outcome'); } }, prepared), /unknown network/);
  assert.equal(await readFile(prepared.destination, 'utf8'), original);
});
test('grant must have explicit safe product parameters', () => {
  for (const invalid of [
    { ...grant, maxDevices: true }, { ...grant, maxDevices: 0 },
    { ...grant, features: [] }, { ...grant, features: ['learning.ai\n'] },
    { ...grant, features: ['learning.ai', 'learning.ai'] },
    { ...grant, expiresAt: 'not-a-date' },
  ]) assert.throws(() => validateGrant(invalid));
});
