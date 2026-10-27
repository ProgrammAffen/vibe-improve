#!/usr/bin/env node
import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { COLLECTIONS, LicenseError, sha256, validateGrant } from '../cloud/functions/license-api/service.mjs';
import { cloudRepository } from '../cloud/functions/license-api/cloud-repository.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
export async function prepareCodeBatch({ root = repoRoot, output, count, productId, grant, now = Date.now() }) {
  if (!Number.isInteger(count) || count < 1 || count > 100 || typeof productId !== 'string' || !/^[a-z][a-z0-9._-]{0,79}$/.test(productId)) throw new LicenseError('INVALID_ADMIN_ARGUMENTS');
  const checked = validateGrant(grant, now);
  if (typeof output !== 'string' || !output) throw new LicenseError('OUTPUT_REQUIRED');
  const base = resolve(root, 'tmp');
  const destination = resolve(root, output);
  const rel = relative(base, destination);
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel) || !destination.endsWith('.json')) throw new LicenseError('OUTPUT_MUST_BE_TMP_JSON');
  let cursor = resolve(root);
  for (const part of relative(cursor, dirname(destination)).split(sep)) {
    if (!part || part === '.' || part === '..') throw new LicenseError('UNSAFE_OUTPUT_PATH');
    cursor = resolve(cursor, part);
    await mkdir(cursor, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
    const st = await lstat(cursor);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new LicenseError('UNSAFE_OUTPUT_PATH');
  }
  const file = await open(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  const codes = Array.from({ length: count }, () => {
    const code = `VI1-${randomBytes(32).toString('hex').toUpperCase()}`;
    return { code, codeHash: sha256(code), status: 'pending' };
  });
  const batch = { schemaVersion: 1, createdAt: new Date(now).toISOString(), productId, grant: checked, codes };
  try {
    await file.chmod(0o600);
    await file.writeFile(JSON.stringify(batch, null, 2) + '\n', { encoding: 'utf8' });
    await file.sync();
  } finally { await file.close(); }
  return { batch, destination };
}
export async function publishCodeBatch(repo, prepared) {
  for (const item of prepared.batch.codes) {
    try {
      await repo.transaction(async tx => {
        if (await tx.get(COLLECTIONS.codes, item.codeHash)) throw new LicenseError('CODE_ALREADY_EXISTS');
        await tx.put(COLLECTIONS.codes, item.codeHash, {
          schemaVersion: 1, codeHash: item.codeHash, productId: prepared.batch.productId,
          ...prepared.batch.grant, status: 'available', createdAt: prepared.batch.createdAt,
        });
      });
      item.status = 'created';
    } catch (e) {
      item.status = 'unknown';
      throw e;
    }
  }
}
async function main() {
  const options = {};
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('Administrator only: --write --env ENV --product PRODUCT --count N --max-devices N --features feature.one,feature.two --expires-at ISO_TIME --output tmp/private-codes.json');
    return;
  }
  const names = new Set(['env', 'product', 'count', 'max-devices', 'features', 'expires-at', 'output']);
  for (let n = 0; n < args.length; n++) {
    if (args[n] === '--write') { if (options.write) throw new LicenseError('INVALID_ADMIN_ARGUMENTS'); options.write = true; continue; }
    const name = args[n].startsWith('--') ? args[n].slice(2) : '';
    if (!names.has(name) || options[name] !== undefined || !args[n + 1] || args[n + 1].startsWith('--')) throw new LicenseError('INVALID_ADMIN_ARGUMENTS');
    options[name] = args[++n];
  }
  if (!options.write || !options.env || !process.env.TENCENTCLOUD_SECRET_ID || !process.env.TENCENTCLOUD_SECRET_KEY) throw new LicenseError('ADMIN_CREDENTIALS_AND_WRITE_REQUIRED');
  if (!options.features || !options['expires-at']) throw new LicenseError('GRANT_REQUIRED');
  const require = createRequire(new URL('../cloud/functions/license-api/package.json', import.meta.url));
  const cloudbase = require('@cloudbase/node-sdk');
  const prepared = await prepareCodeBatch({
    output: options.output, count: Number(options.count), productId: options.product,
    grant: { maxDevices: Number(options['max-devices']), features: options.features.split(','), expiresAt: new Date(options['expires-at']).toISOString() },
  });
  {
    const app = cloudbase.init({ env: options.env, secretId: process.env.TENCENTCLOUD_SECRET_ID, secretKey: process.env.TENCENTCLOUD_SECRET_KEY, sessionToken: process.env.TENCENTCLOUD_SESSION_TOKEN });
    await publishCodeBatch(cloudRepository(app.database()), prepared);
    console.log(`Created ${prepared.batch.codes.length} activation codes; saved only to the requested private output file.`);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof LicenseError ? error.code : 'LICENSE_ADMIN_FAILED'); process.exitCode = 1; });
}
