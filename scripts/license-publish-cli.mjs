#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateCloudApi, unpackCloudData } from './cloudbase-api-private.mjs';
import { prepareCodeBatch } from './license-create-codes.mjs';
import { COLLECTIONS, normalizeCode, sha256, validateGrant } from '../cloud/functions/license-api/service.mjs';
import { atomicWritePrivateJson, readPrivateJson } from './private-json.mjs';

const envId = 'one-person-company-7dao3979fd72e';
async function runCommand(commandType, command) {
  const result = await privateCloudApi({ action: 'RunCommands', body: {
    EnvId: envId,
    MgoCommands: [{ TableName: COLLECTIONS.codes, CommandType: commandType, Command: JSON.stringify(command) }],
  } });
  return unpackCloudData(result.Data || []);
}
async function findRecord(id) {
  const rows = await runCommand('QUERY', { find: COLLECTIONS.codes, filter: { _id: id }, limit: 1 });
  if (!Array.isArray(rows)) throw new Error('LICENSE_CODE_QUERY_INVALID');
  return rows.find(row => row && typeof row === 'object' && row._id === id) || null;
}
export async function publishCodeUsingCli({ code, productId, grant, createdAt = new Date().toISOString() }) {
  const codeHash = sha256(normalizeCode(code));
  const checked = validateGrant(grant);
  const expected = { _id: codeHash, schemaVersion: 1, codeHash, productId, ...checked, status: 'available', createdAt };
  const before = await findRecord(codeHash);
  if (!before) await runCommand('INSERT', { insert: COLLECTIONS.codes, documents: [expected], ordered: true });
  const after = await findRecord(codeHash);
  if (!after || after.codeHash !== codeHash || after.productId !== productId || after.status !== 'available'
      || after.expiresAt !== checked.expiresAt || after.maxDevices !== checked.maxDevices
      || JSON.stringify(after.features) !== JSON.stringify(checked.features)) throw new Error('LICENSE_CODE_PUBLISH_NOT_VERIFIED');
  return { codeHash, created: !before, verified: true };
}
export async function publishPreparedBatchUsingCli(prepared, { publish = publishCodeUsingCli, writeReceipt = atomicWritePrivateJson, now = () => new Date().toISOString() } = {}) {
  const batch = prepared.batch;
  if (!batch || !Array.isArray(batch.codes) || batch.codes.length < 1 || batch.codes.length > 100
      || !/^[a-z][a-z0-9._-]{0,79}$/.test(batch.productId || '') || typeof batch.createdAt !== 'string'
      || !prepared.destination?.endsWith('.json')) throw new Error('INVALID_CODE_BATCH');
  validateGrant(batch.grant);
  const receiptFile = prepared.destination.replace(/\.json$/, '.publication.json');
  const receipt = { schemaVersion: 1, envId, productId: batch.productId, createdAt: now(),
    codes: batch.codes.map(item => {
      const codeHash = sha256(normalizeCode(item.code));
      if (item.codeHash !== codeHash) throw new Error('CODE_HASH_MISMATCH');
      return { codeHash, status: 'pending', created: null, verified: false, updatedAt: now() };
    }) };
  await writeReceipt(receiptFile, receipt);
  for (let n = 0; n < batch.codes.length; n++) {
    const item = batch.codes[n];
    const row = receipt.codes[n];
    row.status = 'publishing'; row.updatedAt = now();
    await writeReceipt(receiptFile, receipt);
    try {
      const result = await publish({ code: item.code, productId: batch.productId, grant: batch.grant, createdAt: batch.createdAt });
      if (result.codeHash !== row.codeHash || result.verified !== true) throw new Error('LICENSE_CODE_PUBLISH_NOT_VERIFIED');
      row.status = 'verified'; row.created = result.created === true; row.verified = true; row.updatedAt = now();
      await writeReceipt(receiptFile, receipt);
    } catch (error) {
      row.status = 'unknown'; row.updatedAt = now();
      row.error = /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'LICENSE_CLI_PUBLISH_FAILED';
      await writeReceipt(receiptFile, receipt);
      throw error;
    }
  }
  return { receipt, receiptFile };
}
async function main() {
  const options = {};
  const allowed = new Set(['product', 'count', 'max-devices', 'features', 'expires-at', 'output', 'input']);
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('Use the workspace TCB login: --write --product PRODUCT --count N --max-devices N --features app.access --expires-at ISO_TIME --output tmp/private/codes.json; resume with --write --input tmp/private/codes.json. Raw batch files are immutable; hash-only receipts use .publication.json.');
    return;
  }
  for (let n = 0; n < args.length; n++) {
    if (args[n] === '--write') { options.write = true; continue; }
    const name = args[n].replace(/^--/, '');
    if (!allowed.has(name) || options[name] !== undefined || !args[n + 1] || args[n + 1].startsWith('--')) throw new Error('INVALID_ARGUMENTS');
    options[name] = args[++n];
  }
  if (!options.write) throw new Error('WRITE_AND_GRANT_REQUIRED');
  let prepared;
  if (options.input) {
    if (Object.keys(options).some(key => !['input', 'write'].includes(key))) throw new Error('INPUT_CANNOT_GENERATE_NEW_CODES');
    const existing = await readPrivateJson(options.input);
    prepared = { batch: existing.data, destination: existing.destination };
  } else {
    if (!options.output || !options.features || !options['expires-at']) throw new Error('WRITE_AND_GRANT_REQUIRED');
    prepared = await prepareCodeBatch({ output: options.output, count: Number(options.count), productId: options.product,
      grant: { maxDevices: Number(options['max-devices']), features: options.features.split(','), expiresAt: new Date(options['expires-at']).toISOString() } });
  }
  await publishPreparedBatchUsingCli(prepared);
  console.log(`Published ${prepared.batch.codes.length} activation code hashes. Raw codes remain only in the private output file.`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  console.error(/^[A-Z0-9_]+$/.test(error.message) ? error.message : 'LICENSE_CLI_PUBLISH_FAILED');
  process.exitCode = 1;
});
