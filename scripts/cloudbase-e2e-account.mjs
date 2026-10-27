#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { privateCloudApi, workspaceRoot } from './cloudbase-api-private.mjs';
import { publishCodeUsingCli } from './license-publish-cli.mjs';
import { atomicWritePrivateJson } from './private-json.mjs';

const envId = 'one-person-company-7dao3979fd72e';
const privateDir = join(workspaceRoot, 'tmp', 'private');
const privateFile = join(privateDir, 'e2e-credentials.json');
const evidenceDir = join(workspaceRoot, 'tmp', 'checks', '2026-10-18-cloudbase');
const origin = 'https://one-person-company-7dao3979fd72e-1302619113.tcloudbaseapp.com';
process.umask(0o077);
async function savePrivate(data) {
  await atomicWritePrivateJson(privateFile, data);
}
async function signIn(identifier, password) {
  const response = await fetch(`https://${envId}.api.tcloudbasegateway.com/auth/v1/signin`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ username: identifier, password }), signal: AbortSignal.timeout(20_000),
  });
  const result = await response.json();
  if (!response.ok || result.error || !result.access_token) return { success: false, error: result.error || `HTTP_${response.status}` };
  return { success: true, uid: result.sub };
}
async function main() {
  if (process.argv[2] !== '--create-test-user') throw new Error('EXPLICIT_TEST_USER_FLAG_REQUIRED');
  await mkdir(privateDir, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(privateDir);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('UNSAFE_PRIVATE_DIRECTORY');
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  let credentials;
  try {
    const existing = await lstat(privateFile);
    if (!existing.isFile() || existing.isSymbolicLink() || (existing.mode & 0o077)) throw new Error('PRIVATE_FILE_PERMISSION_INVALID');
    credentials = JSON.parse(await readFile(privateFile, 'utf8'));
    if (!credentials.testOnly || credentials.envId !== envId) throw new Error('EXISTING_FILE_NOT_THIS_TEST');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const suffix = randomBytes(6).toString('hex');
    credentials = { schemaVersion: 1, testOnly: true, envId, username: `vi-e2e-${suffix}`, email: `vi-e2e-${suffix}@example.invalid`,
      password: `Vi9!${randomBytes(12).toString('hex')}`, activationCode: `VI1-${randomBytes(32).toString('hex').toUpperCase()}`,
      productId: 'vibe-improve', grant: { maxDevices: 2, features: ['app.access'], expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString() },
      createdAt: new Date().toISOString(), accountCreated: false, codePublished: false };
    const file = await open(privateFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(JSON.stringify(credentials, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
  }
  const plan = { envId, type: 'externalUser', dedicatedSyntheticAccount: true, sendsEmail: false, grantsAdminRole: false,
    activation: { productId: credentials.productId, ...credentials.grant }, deletes: [], rawSecretsFile: 'tmp/private/e2e-credentials.json' };
  await writeFile(join(evidenceDir, 'e2e-plan.json'), JSON.stringify(plan, null, 2), { mode: 0o600 });
  if (!credentials.accountCreated) {
    const created = await privateCloudApi({ action: 'CreateUser', body: {
      EnvId: envId, Name: credentials.username, Password: credentials.password, Type: 'externalUser', UserStatus: 'ACTIVE',
      NickName: 'Vibe Improve E2E Test', Email: credentials.email, Description: 'Synthetic Vibe Improve integration test; no real email; no administrator role.',
    } });
    const uid = created.Data?.Uid || created.Uid;
    if (!uid) throw new Error('CREATE_USER_NO_UID');
    credentials.uid = uid;
    credentials.accountCreated = true;
    await savePrivate(credentials);
  }
  if (credentials.emailPasswordLogin === undefined) {
    const emailResult = await signIn(credentials.email, credentials.password);
    credentials.emailPasswordLogin = emailResult.success && emailResult.uid === credentials.uid;
    credentials.emailLoginError = emailResult.success ? null : emailResult.error;
  }
  if (!credentials.emailPasswordLogin && credentials.usernamePasswordLogin === undefined) {
    const usernameResult = await signIn(credentials.username, credentials.password);
    credentials.usernamePasswordLogin = usernameResult.success && usernameResult.uid === credentials.uid;
    credentials.usernameLoginError = usernameResult.success ? null : usernameResult.error;
  }
  await savePrivate(credentials);
  if (!credentials.codePublished) {
    await publishCodeUsingCli({ code: credentials.activationCode, productId: credentials.productId, grant: credentials.grant, createdAt: credentials.createdAt });
    credentials.codePublished = true;
    await savePrivate(credentials);
  }
  const proof = { envId, testOnly: true, created: credentials.accountCreated, roleAssignedByScript: false, verifiedEmailClaimSetByScript: false,
    emailPasswordLogin: credentials.emailPasswordLogin, usernamePasswordLogin: credentials.usernamePasswordLogin ?? null,
    codeHashPublishedAndReadBack: credentials.codePublished, rawSecretsFile: 'tmp/private/e2e-credentials.json',
    grant: credentials.grant, checkedAt: new Date().toISOString(), cleanupPerformed: false };
  await writeFile(join(evidenceDir, 'e2e-account-verification.json'), JSON.stringify(proof, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(proof, null, 2));
  if (!credentials.emailPasswordLogin) console.log('Email/password was not verified; use the recorded username test result and do not claim the email flow passed.');
}
main().catch(error => { console.error(/^[A-Z0-9_]+$/.test(error.message) ? error.message : 'E2E_ACCOUNT_SETUP_FAILED'); process.exitCode = 1; });
