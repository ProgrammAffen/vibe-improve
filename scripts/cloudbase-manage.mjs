#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envId = 'one-person-company-7dao3979fd72e';
const region = 'ap-shanghai';
const hostingDomain = 'one-person-company-7dao3979fd72e-1302619113.tcloudbaseapp.com';
const domains = ['localhost', '127.0.0.1', hostingDomain];
const evidence = join(root, 'tmp', 'checks', '2026-10-18-cloudbase');
const schema = JSON.parse(await readFile(join(root, 'cloud', 'schema', 'license-schema.json'), 'utf8'));
const collections = schema.collections.map(item => item.name);
if (collections.some(name => !/^vi_[a-z_]+$/.test(name))) throw new Error('Only vi_ collections are allowed.');
const command = process.argv[2] || 'inspect';
if (!['inspect', 'plan', 'apply', 'verify'].includes(command)) throw new Error('Use inspect, plan, apply, or verify.');
await mkdir(evidence, { recursive: true, mode: 0o700 });

function parseCli(stdout) {
  const clean = stdout.replace(/\x1b\[[0-9;]*m/g, '');
  const begin = clean.indexOf('{');
  if (begin < 0) throw new Error('CLI did not return JSON.');
  const parsed = JSON.parse(clean.slice(begin));
  if (parsed.success === false || (parsed.code && ![0, '0', 'SUCCESS'].includes(parsed.code))) {
    throw new Error(`CloudBase request failed (${String(parsed.code || 'unknown')}).`);
  }
  let body = parsed.data && !parsed.EnvList && !parsed.Data ? parsed.data : parsed;
  if (body.Response) body = body.Response;
  if (body.Error) throw new Error(`CloudBase API failed (${String(body.Error.Code || 'unknown')}).`);
  return body;
}
async function api(service, action, params, apiVersion = '2018-06-08') {
  const args = [join(root, 'scripts', 'cloudbase-cli.mjs'), 'api', service, action, '--api-version', apiVersion, '--body', JSON.stringify(params), '--json', '-r', region];
  return new Promise((resolveCall, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.once('error', reject);
    child.once('exit', code => {
      if (code !== 0) {
        const errorCode = /"code"\s*:\s*"([A-Za-z0-9_.-]+)"/.exec(stdout + stderr)?.[1] || 'CLI_REQUEST_FAILED';
        reject(new Error(`${service}.${action}: ${errorCode}`));
        return;
      }
      try { resolveCall(parseCli(stdout)); } catch (error) { reject(error); }
    });
  });
}
const tcb = (action, extra = {}) => api('tcb', action, { EnvId: envId, ...extra });
async function inspect() {
  const environmentResponse = await tcb('DescribeEnvs');
  const envList = environmentResponse.EnvList || environmentResponse.Environments || environmentResponse.Data || [];
  const environment = envList.find(item => item.EnvId === envId);
  if (!environment) throw new Error('Target environment was not returned.');
  const tag = environment.Databases?.[0]?.InstanceId;
  if (!tag) throw new Error('Target environment has no confirmed NoSQL instance.');
  const login = await tcb('DescribeLoginConfig');
  const providerResponse = await tcb('GetProviders');
  const providers = providerResponse.Data || providerResponse.Providers || [];
  const domainResponse = await tcb('DescribeAuthDomains');
  const tableResponse = await api('flexdb', 'ListTables', { Tag: tag, MgoLimit: 100, MgoOffset: 0 }, '2018-11-27');
  const permissionsResponse = await tcb('DescribeResourcePermission', { ResourceType: 'collection', Resources: collections });
  const permissionRows = permissionsResponse.Data?.PermissionList || permissionsResponse.PermissionList || [];
  const snapshot = {
    envId, region, status: environment.Status, databaseStatus: environment.Databases?.[0]?.Status,
    logsEnabled: environment.LogServices?.some(item => Boolean(item.TopicId)) ?? false,
    login: Object.fromEntries(['EmailLogin', 'UserNameLogin', 'PhoneNumberLogin', 'AnonymousLogin'].map(key => [key, login[key]])),
    providers: providers.map(provider => ({ id: provider.Id, type: provider.ProviderType, on: provider.On, defaultEmailSending: provider.EmailConfig?.On })),
    domains: (domainResponse.Domains || []).map(item => ({ domain: item.Domain, status: item.Status })),
    collections: (tableResponse.Tables || []).filter(item => collections.includes(item.TableName)).map(item => ({ name: item.TableName, status: item.Status })),
    permissions: permissionRows.map(row => ({ name: row.Resource, permission: row.Permission, rule: row.SecurityRule || '' })),
    checkedAt: new Date().toISOString(),
  };
  await writeFile(join(evidence, `${command}-snapshot.json`), JSON.stringify(snapshot, null, 2), { mode: 0o600 });
  return { snapshot, tag, login, providers };
}
function makePlan(current) {
  return {
    envId, region, createdAt: new Date().toISOString(),
    createCollections: collections.filter(name => !current.snapshot.collections.some(item => item.name === name)),
    setCollectionPermissions: collections.map(name => ({ name, permission: 'ADMINONLY' })),
    login: { EmailLogin: true, UserNameLogin: true, preserveOtherSettings: true },
    emailProvider: { enable: true, defaultSending: true, preserveTemplatesAndOtherProviders: true },
    addDomains: domains.filter(domain => !current.snapshot.domains.some(item => item.domain === domain)),
    createLogResource: !current.snapshot.logsEnabled,
    deletes: [],
  };
}
function verify(current) {
  const { snapshot } = current;
  const email = snapshot.providers.find(item => item.type === 'EMAIL');
  const failures = [];
  if (!snapshot.logsEnabled) failures.push('environment log resource not ready');
  for (const name of collections) {
    if (!snapshot.collections.some(item => item.name === name)) failures.push(`missing collection: ${name}`);
    if (!snapshot.permissions.some(item => item.name === name && item.permission === 'ADMINONLY')) failures.push(`permission not ADMINONLY: ${name}`);
  }
  if (!snapshot.login.EmailLogin || !snapshot.login.UserNameLogin) failures.push('email/password login not enabled');
  if (email?.on !== 'TRUE' || email.defaultEmailSending !== 'TRUE') failures.push('email provider/default sending not enabled');
  for (const domain of domains) if (!snapshot.domains.some(item => item.domain === domain && item.status === 'ENABLE')) failures.push(`missing enabled source: ${domain}`);
  return { envId, verifiedAt: new Date().toISOString(), passed: failures.length === 0, failures, snapshot };
}

try {
  const current = await inspect();
  if (command === 'inspect') { console.log(JSON.stringify(current.snapshot, null, 2)); process.exit(0); }
  const plan = makePlan(current);
  await writeFile(join(evidence, 'plan.json'), JSON.stringify(plan, null, 2), { mode: 0o600 });
  if (command === 'plan') { console.log(JSON.stringify(plan, null, 2)); process.exit(0); }
  if (command === 'apply') {
    if (plan.createLogResource) await tcb('CreateEnvResource', {Resources: ['log']});
    for (const name of plan.createCollections) {
      await api('flexdb', 'CreateTable', { Tag: current.tag, TableName: name }, '2018-11-27');
      console.log(`Created ${name}`);
    }
    for (const name of collections) {
      await tcb('ModifyResourcePermission', { ResourceType: 'collection', Resource: name, Permission: 'ADMINONLY' });
      console.log(`Restricted ${name}`);
    }
    for (const key of ['EmailLogin', 'UserNameLogin', 'PhoneNumberLogin', 'AnonymousLogin']) {
      if (typeof current.login[key] !== 'boolean') throw new Error(`Cannot preserve missing login setting ${key}.`);
    }
    if (!current.login.EmailLogin || !current.login.UserNameLogin) await tcb('ModifyLoginConfig', {
        EmailLogin: true, UserNameLogin: true,
        PhoneNumberLogin: current.login.PhoneNumberLogin, AnonymousLogin: current.login.AnonymousLogin,
      });
    const email = current.providers.find(provider => provider.ProviderType === 'EMAIL');
    if (!email?.Id) throw new Error('EMAIL provider ID is unknown.');
    if (email.On !== 'TRUE' || email.EmailConfig?.On !== 'TRUE') await tcb('ModifyProvider', { Id: email.Id, ProviderType: 'EMAIL', On: 'TRUE', EmailConfig: { On: 'TRUE' } });
    if (plan.addDomains.length) await tcb('CreateAuthDomain', { Domains: plan.addDomains });
    console.log('Updated email login, platform email sending, and sources.');
  }
  const result = verify(command === 'apply' ? await inspect() : current);
  await writeFile(join(evidence, 'verification.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
} catch (error) {
  await writeFile(join(evidence, 'last-error.json'), JSON.stringify({ envId, command, failedAt: new Date().toISOString(), message: error.message }, null, 2), { mode: 0o600 });
  console.error(error.message);
  process.exitCode = 1;
}
