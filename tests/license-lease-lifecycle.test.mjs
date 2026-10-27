import * as trustedClock from '../packages/license/trusted-clock.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID, randomBytes, generateKeyPairSync, sign, webcrypto, createHash} from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import {verifyLicenseCertificate, verifyServerTimeProof} from '../packages/license/verify-certificate.mjs';
import {createLicenseService, createSigner, COLLECTIONS} from '../cloud/functions/license-api/service.mjs';
import * as diagnosticContract from '../cloud/functions/license-api/diagnostic-contract.mjs';

const compile = async path => ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText;
const api = await compile('../apps/local-ui/src/api.ts'), logging = await compile('../apps/local-ui/src/logger.ts');
const password = {exports: {}};
vm.runInNewContext(await compile('../apps/local-ui/src/password-validation.ts'), {module: password, exports: password.exports});
const {privateKey, publicKey} = generateKeyPairSync('ed25519');
const trust = {keyId: 'synthetic-lease-key', issuer: 'synthetic-issuer', audience: 'synthetic-client', productId: 'vibe-improve', publicKeySpki: publicKey.export({type: 'spki', format: 'der'}).toString('base64url')};
const day = 86400_000, hash = value => createHash('sha256').update(value).digest('hex');
const turn = () => new Promise(resolve => setImmediate(resolve));
function vault() {
  return {record: null, writes: [], async read() {return structuredClone(this.record);}, async write(value) {this.record = structuredClone(value); this.writes.push(structuredClone(value));}, async clear() {this.record = null;}};
}
function backend({licensed = true, maxDevices = 2} = {}) {
  const state = {now: Date.UTC(2026, 9, 20), licensed, maxDevices, leaseDuration: 7 * day, devices: new Map(), receipts: new Map(), requests: [], rejectRenew: null, failingRenew: 0, loseResponse: false};
  const entitlement = () => ({licenseId: 'synthetic-license', expiresAt: new Date(state.entitlementExpiresAt ?? Date.UTC(2026, 10, 20)).toISOString(), maxDevices: state.maxDevices, features: ['app.access']});
  function issue(device, leaseToken) {
    const iso = offset => new Date(state.now + offset).toISOString();
    const claims = {schemaVersion: 1, keyId: trust.keyId, issuer: trust.issuer, audience: trust.audience, productId: trust.productId, userId: 'synthetic-user', deviceId: device.deviceId, bindingId: device.bindingId, licenseId: 'synthetic-license', features: ['app.access'], issuedAt: iso(0), notBefore: iso(0), expiresAt: entitlement().expiresAt, leaseExpiresAt: new Date(Math.min(state.now + state.leaseDuration, Date.parse(entitlement().expiresAt))).toISOString(), offlineUntil: new Date(Math.min(state.now + state.leaseDuration, Date.parse(entitlement().expiresAt))).toISOString()};
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const certificate = {algorithm: 'Ed25519', keyId: trust.keyId, payload, signature: sign(null, Buffer.from(payload), privateKey).toString('base64url')};
    return {serverNow: iso(0), entitlement: entitlement(), device: {...device}, certificate, leaseToken};
  }
  function bind(id, name = 'Synthetic Mac') {
    const previous = state.devices.get(id);
    if (!previous && state.devices.size >= state.maxDevices) throw {code: 'DEVICE_LIMIT_REACHED'};
    const device = {...previous, deviceId: id, bindingId: previous?.bindingId ?? randomUUID(), deviceName: name, leaseToken: randomBytes(32).toString('hex')};
    state.devices.set(id, device);
    return issue(device, device.leaseToken);
  }
  state.add = (id, name) => bind(id, name);
  state.call = async request => {
    state.requests.push(structuredClone(request));
    const {action, deviceId} = request;
    try {
      if (action === 'status') return {ok: true, data: {status: state.licensed ? 'valid' : 'unlicensed', entitlement: state.licensed ? entitlement() : null, device: state.devices.get(deviceId) ?? null}};
      if (action === 'devices' && state.failingDevices) throw {name: 'TypeError', message: 'Failed to fetch'};
      if (action === 'devices') return {ok: true, data: {devices: [...state.devices.values()].map(({leaseToken, ...device}) => device), maxDevices: state.maxDevices}};
      if (action === 'revoke') {state.devices.delete(deviceId); return {ok: true, data: {revoked: true}};}
      if (action === 'activate') {state.licensed = true; return {ok: true, data: bind(deviceId, request.deviceName)};}
      if (action === 'bind') return {ok: true, data: bind(deviceId, request.deviceName)};
      if (action === 'renew') {
        if (state.now >= Date.parse(entitlement().expiresAt)) throw {code:'LICENSE_EXPIRED'};
        if (state.rejectRenew) throw {code: state.rejectRenew};
        if (state.failingRenew-- > 0) throw {name: 'TypeError', message: 'Failed to fetch'};
        let result = state.receipts.get(request.requestId);
        if (!result) {
          const device = state.devices.get(deviceId);
          if (device?.legacy && !request.leaseToken) {
            delete device.legacy; device.leaseToken = randomBytes(32).toString('hex');
            result = issue(device, device.leaseToken); state.receipts.set(request.requestId, result);
            return {ok: true, data: result};
          }
          if (!device || device.bindingId !== request.bindingId || device.leaseToken !== request.leaseToken) throw {code: 'DEVICE_REVOKED'};
          assert.equal(request.nextLeaseToken, hash('vibe-improve:lease-renewal:v2:' + request.leaseToken + ':' + request.renewalId));
          device.leaseToken = request.nextLeaseToken;
          result = issue(device, device.leaseToken); state.receipts.set(request.requestId, result);
        }
        if (state.loseResponse) {state.loseResponse = false; throw {name: 'TypeError', message: 'Failed to fetch'};}
        return {ok: true, data: result};
      }
      throw {code: 'INVALID_REQUEST'};
    } catch (error) {
      if (error.name === 'TypeError') throw error;
      return {ok: false, error: {code: error.code, retryable: false}};
    }
  };
  return state;
}
function fixture(server, store = vault(), deviceId = 'dev_synthetic_current_0123456789') {
  const events = new Map(), timers = new Map(), local = new Map(); let timerID = 0, logger, sdkStorage, current = null;
  const user = {id: 'synthetic-user', email: 'synthetic@example.invalid', user_metadata: {name: 'Synthetic'}};
  const session = () => ({access_token: 'SYNTHETIC_ACCESS_TOKEN', refresh_token: 'SYNTHETIC_REFRESH_TOKEN', expires_at: new Date(server.now + 7200_000).toISOString(), expires_in: 7200, user});
  const authResult = () => {current = user; return {data: {user, session: session()}};};
  server.authCalls ??= {password:0,restore:0,refresh:0};
  const auth = {signInWithPassword: async () => {server.authCalls.password++; return authResult();}, getUser: async () => ({data: {user: current}}), setSession: async () => {server.authCalls.restore++; if (server.authError) throw server.authError; return authResult();}, refreshSession: async () => {server.authCalls.refresh++; if (server.authError) throw server.authError; return authResult();}, signOut: async () => {current = null; return {data: {}};}};
  class Clock extends Date {static now() {return server.wallNow ?? server.now;}}
  const sandbox = {structuredClone, Date: Clock, TextEncoder, Uint8Array, crypto: {randomUUID, subtle: webcrypto.subtle}, navigator: {onLine: true}, console: {info() {}},
    setTimeout: (callback, delay) => {const id = ++timerID; timers.set(id, {callback, delay}); return id;}, clearTimeout: id => timers.delete(id),
    localStorage: {getItem: key => local.get(key) ?? null, setItem: (key, value) => local.set(key, value)},
    document: {hidden: false, documentElement: {lang: 'en'}, addEventListener() {}},
    window: {vibeNative: {deviceId, deviceName: 'Synthetic Host Mac', preferences: {}, session: store, ...(server.clockState && {clock:{sample:async()=>({...server.clockState})}})}, addEventListener: (name, listener) => events.set(name, listener)},
    require: name => {
      if (name.endsWith('trusted-clock.mjs')) return trustedClock;
      if (name === '@cloudbase/js-sdk') return {default: {init: () => ({auth: options => {sdkStorage = options.storage; return auth;}, callFunction: async ({data}) => {const result=await server.call(data);if(server.clockState&&result.ok){const payload=Buffer.from(JSON.stringify({schemaVersion:1,...trust,publicKeySpki:undefined,purpose:'server-time-v1',userId:user.id,nonce:data.clientTraceId,serverTime:new Date(server.now).toISOString()})).toString('base64url');result.timeProof={algorithm:'Ed25519',keyId:trust.keyId,payload,signature:sign(null,Buffer.from(payload),privateKey).toString('base64url')};}return {result};}})}};
      if (name.endsWith('public-license-key.json')) return {default: trust};
      if (name.endsWith('verify-certificate.mjs')) return {verifyServerTimeProof, verifyLicenseCertificate: (certificate, key, expected) => verifyLicenseCertificate(certificate, key, {...expected, now: expected.now ?? server.now})};
      if (name === './password-validation') return password.exports;
      if (name.endsWith('diagnostic-contract.mjs')) return diagnosticContract;
      if (name === './logger') return logger;
      throw Error('UNEXPECTED_IMPORT');
    }};
  const logModule = {exports: {}}; vm.runInNewContext(logging, {...sandbox, module: logModule, exports: logModule.exports}); logger = logModule.exports;
  const module = {exports: {}}; vm.runInNewContext(api, {...sandbox, module, exports: module.exports});
  return {service: module.exports.default, store, timers, local, logger, close: () => events.get('pagehide')(), online: () => events.get('online')(), wake: () => events.get('vibe-clock-check')(), sdkStorage: () => sdkStorage};
}
async function loginAndLink(f) {
  await f.service.login('synthetic@example.invalid', 'SyntheticPassword123');
  if ((await f.service.getSnapshot()).bindingPrompt) await f.service.bindDevice();
}
async function runRetry(f) {
  const retry=f.store.record?.networkRetry;
  assert.ok(retry,'pending background retry');
  const delta=Math.max(0,retry.nextRetryAt-f.server.now);f.server.now+=delta;if(f.server.clockState)f.server.clockState.continuousMs+=delta;
  const timer=[...f.timers.entries()].find(([,v])=>v.callback.toString().includes('retryNetworkInBackground'));
  assert.ok(timer,'one recovery timer');f.timers.delete(timer[0]);timer[1].callback();
  for(let i=0;i<70;i++)await turn();
}
async function signedIn(options) {
  const server = backend(options), f = fixture(server); await f.service.whenReady(); await loginAndLink(f);
  return {...f, server};
}

test('confirmed device binding persists a verified lease and existing machines reuse the same slot', async () => {
  const f = await signedIn();
  const state = await f.service.getSnapshot(), binding = f.server.requests.find(value => value.action === 'bind');
  assert.equal(state.license.active, true); assert.equal(f.server.devices.size, 1);
  assert.equal(binding.deviceName, 'Synthetic Host Mac');
  assert.equal(state.devices.length, 1); assert.equal(state.devices[0].deviceId, state.deviceId);
  assert.equal(state.devicesState, 'ready');
  assert.match(f.store.record.licenseCache.leaseToken, /^[a-f0-9]{64}$/);
  assert.equal(f.store.record.licenseCache.renewal, null);
  const firstBinding = state.license.bindingId;
  await loginAndLink(f);
  assert.equal(f.server.devices.size, 1); assert.equal((await f.service.getSnapshot()).license.bindingId, firstBinding);
});

test('cold restart restores the local binding and device list without requests and refreshing queries only the list', async () => {
  const f = await signedIn(), binding = (await f.service.getSnapshot()).license.bindingId;
  f.close(); f.server.requests.length = 0;
  const restarted = fixture(f.server, f.store); await restarted.service.whenReady();
  const restored = await restarted.service.getSnapshot();
  assert.equal(restored.license.active, true); assert.equal(restored.devicesState, 'ready'); assert.equal(restored.devices.length, 1);
  assert.equal(restored.deviceId, (await f.service.getSnapshot()).deviceId);
  assert.deepEqual(f.server.requests, []);
  assert.equal(f.store.record.licenseCache.deviceList.devices[0].bindingId, binding);
  await restarted.service.loadDevices(); assert.deepEqual(f.server.requests, []);
  await restarted.service.loadDevices(true);
  const state = await restarted.service.getSnapshot();
  assert.equal(state.devicesState, 'ready'); assert.equal(state.devices.length, 1);
  assert.equal(state.devices[0].deviceId, state.deviceId); assert.equal(state.devices[0].bindingId, binding);
  assert.deepEqual(f.server.requests.map(r => r.action), ['devices']);
  await restarted.service.loadDevices(); assert.equal(f.server.requests.length, 1);
});

test('failed device loading is distinct from an empty list and does not remove a valid lease', async () => {
  const f = await signedIn(); f.close(); f.server.requests.length = 0;
  const restarted = fixture(f.server, f.store); await restarted.service.whenReady();
  const token = f.store.record.licenseCache.leaseToken;
  f.server.failingDevices = true;
  await assert.rejects(restarted.service.loadDevices(true));
  let state = await restarted.service.getSnapshot();
  assert.equal(state.devicesState, 'error'); assert.ok(state.devicesError); assert.equal(state.license.active, true);
  assert.ok(state.user); assert.equal(f.store.record.licenseCache.leaseToken, token);
  f.server.failingDevices = false; await restarted.service.loadDevices();
  state = await restarted.service.getSnapshot();
  assert.equal(state.devicesState, 'ready'); assert.equal(state.devicesError, null); assert.equal(state.devices.length, 1);
  f.server.failingDevices = true; await assert.rejects(restarted.service.loadDevices(true));
  state = await restarted.service.getSnapshot();
  assert.equal(state.devicesState, 'error'); assert.equal(state.devices.length, 1); assert.equal(state.license.active, true);
  assert.ok(f.server.requests.every(r => r.action === 'devices'));
});

test('old eight-field caches remain valid and fetch missing device metadata without claiming again', async () => {
  const f = await signedIn(); delete f.store.record.licenseCache.deviceList;
  f.close(); f.server.requests.length = 0;
  const restarted = fixture(f.server, f.store); await restarted.service.whenReady();
  const before = await restarted.service.getSnapshot(); assert.equal(before.license.active, true); assert.equal(before.devicesState, 'idle');
  assert.equal(f.server.requests.length, 0);
  await restarted.service.loadDevices();
  const after = await restarted.service.getSnapshot(); assert.equal(after.devices.length, 1); assert.equal(after.devicesState, 'ready');
  assert.deepEqual(f.server.requests.map(r => r.action), ['devices']); assert.ok(f.store.record.licenseCache.deviceList);
});

test('cloud device limit changes update and persist locally without rebuilding or granting local slots', async () => {
  const f = await signedIn(); assert.equal((await f.service.getSnapshot()).devicesMaxDevices, 2);
  const binding = f.store.record.licenseCache.bindingId, token = f.store.record.licenseCache.leaseToken;
  for (const maximum of [5, 1]) {
    f.server.maxDevices = maximum; await f.service.loadDevices(true);
    assert.equal((await f.service.getSnapshot()).devicesMaxDevices, maximum);
    assert.equal(f.store.record.licenseCache.maxDevices, maximum); assert.equal(f.store.record.licenseCache.deviceList.maxDevices, maximum);
  }
  assert.equal(f.store.record.licenseCache.bindingId, binding); assert.equal(f.store.record.licenseCache.leaseToken, token);
  f.close(); f.server.requests.length = 0;
  const restarted = fixture(f.server, f.store); await restarted.service.whenReady();
  assert.equal((await restarted.service.getSnapshot()).devicesMaxDevices, 1); assert.equal(f.server.requests.length, 0);
});

test('device queries are single-flight, expose loading and ignore responses after logout', async () => {
  const f = await signedIn(); f.server.requests.length = 0;
  const call = f.server.call; let release;
  const gate = new Promise(resolve => {release = resolve;});
  f.server.call = async request => {if (request.action === 'devices') await gate; return call(request);};
  const first = f.service.loadDevices(true), second = f.service.loadDevices(true);
  await turn(); assert.equal((await f.service.getSnapshot()).devicesState, 'loading');
  await f.service.logout(); release(); await Promise.all([first, second]);
  const state = await f.service.getSnapshot();
  assert.equal(state.user, null); assert.equal(state.devicesState, 'idle'); assert.equal(state.devices.length, 0);
  assert.deepEqual(f.server.requests.map(r => r.action), ['devices']);
});

test('only a successful device response can establish a genuinely empty list', async () => {
  const f = await signedIn(); f.server.devices.clear(); f.server.requests.length = 0;
  await f.service.loadDevices(true);
  let state = await f.service.getSnapshot();
  assert.equal(state.devicesState, 'ready'); assert.equal(state.devices.length, 0);
  f.server.call = async () => ({ok: true, data: {}});
  await assert.rejects(f.service.loadDevices(true));
  state = await f.service.getSnapshot(); assert.equal(state.devicesState, 'error'); assert.ok(state.devicesError);
});

test('a failed capacity query cannot prompt or claim a new device; an activated binding survives a metadata failure', async()=>{
 const server=backend();server.failingDevices=true;const f=fixture(server);await f.service.whenReady();await loginAndLink(f);
 let state=await f.service.getSnapshot();assert.ok(state.user);assert.equal(state.license.active,false);assert.equal(state.bindingPrompt,null);assert.equal(server.devices.size,0);assert.ok(f.store.record.networkRetry);
 server.failingDevices=false;await f.service.requestDeviceBinding();assert.ok((await f.service.getSnapshot()).bindingPrompt);await f.service.bindDevice();assert.equal((await f.service.getSnapshot()).license.active,true);f.close();
 const g=await signedIn({licensed:false});g.server.failingDevices=true;await g.service.activate('VI-SYNTHETIC-REVIEW-CODE');state=await g.service.getSnapshot();assert.equal(state.license.active,true);assert.equal(state.devicesState,'error');assert.equal(g.server.devices.size,1);g.close();
});

test('activation sends identity and accepts the server binding atomically without a second bind request', async () => {
  const f = await signedIn({licensed: false}); f.server.requests.length = 0;
  await f.service.activate('VI-SYNTHETIC-REVIEW-CODE');
  const requests = f.server.requests;
  assert.deepEqual(requests.map(value => value.action), ['activate', 'devices']);
  assert.equal(requests[0].deviceId, (await f.service.getSnapshot()).deviceId);
  assert.equal((await f.service.getSnapshot()).license.active, true);
});

test('full slots preserve account management and removing an old machine asks before binding', async () => {
  const server = backend(); server.add('dev_synthetic_old_01'); server.add('dev_synthetic_old_02');
  const f = fixture(server); await f.service.whenReady(); await loginAndLink(f);
  let state = await f.service.getSnapshot(); assert.ok(state.user); assert.equal(state.license.status, 'device_limit'); assert.equal(state.license.active, false); assert.equal(state.devices.length, 2);
  await f.service.revokeDevice('dev_synthetic_old_01');
  state = await f.service.getSnapshot(); assert.equal(state.license.active, false); assert.ok(state.bindingPrompt); assert.equal(server.devices.size, 1); await f.service.bindDevice(); state = await f.service.getSnapshot(); assert.equal(state.license.active,true); assert.equal(server.devices.size,2); assert.ok(server.devices.has(state.deviceId));
});

test('removing this machine preserves account management, clears its lease and suppresses automatic claims', async () => {
  const f = await signedIn(), deviceId = (await f.service.getSnapshot()).deviceId;
  f.server.requests.length = 0; await f.service.revokeDevice(deviceId);
  assert.ok((await f.service.getSnapshot()).user); assert.equal(f.store.record.licenseCache.status, 'device_revoked'); assert.equal(f.store.record.licenseCache.leaseToken, ''); assert.equal(f.server.devices.has(deviceId), false);
  assert.deepEqual(f.server.requests.map(value => value.action), ['revoke']);
  await f.service.refreshLicense(); assert.equal((await f.service.getSnapshot()).license.status, 'device_revoked');
  assert.ok(!f.server.requests.some(value => value.action === 'bind'));
  f.close(); f.server.now += 6 * 60_000; const restarted = fixture(f.server, f.store); await restarted.service.whenReady();
  assert.ok((await restarted.service.getSnapshot()).user); assert.equal((await restarted.service.getSnapshot()).license.status, 'device_revoked');
  assert.ok(!f.server.requests.some(value => value.action === 'bind'));
  await restarted.service.requestDeviceBinding(); await restarted.service.bindDevice(); assert.equal((await restarted.service.getSnapshot()).license.active, true);
});

test('removing another machine keeps the current lease token and renews without consuming a new slot', async () => {
  const f = await signedIn(); f.server.add('dev_synthetic_old_01'); f.server.requests.length = 0;
  await f.service.revokeDevice('dev_synthetic_old_01');
  assert.equal((await f.service.getSnapshot()).license.active, true);
  assert.deepEqual(f.server.requests.map(value => value.action), ['revoke', 'renew', 'devices']);
});

test('verified cold restart makes no cloud requests and retains the stable device binding', async () => {
  const f = await signedIn(), prior = structuredClone(f.store.record); f.close(); f.server.requests.length = 0; f.server.now += 60_000;
  const next = fixture(f.server, f.store); await next.service.whenReady();
  assert.equal((await next.service.getSnapshot()).license.active, true); assert.equal(f.server.requests.length, 0); assert.deepEqual(f.store.record, prior);
});

test('lost renewal response survives restart and replays the same persisted token operation', async () => {
  const f = await signedIn(); f.server.loseResponse = true;
  await assert.rejects(f.service.refreshLicense());
  const attempt = structuredClone(f.store.record.licenseCache.renewal);
  assert.equal(attempt.retryCount, 1); assert.equal((await f.service.getSnapshot()).license.active, true);
  const response = f.server.receipts.get(attempt.requestId); const expiry = response.device.leaseExpiresAt ?? JSON.parse(Buffer.from(response.certificate.payload, 'base64url')).leaseExpiresAt;
  f.close(); f.server.now += 60_000;
  const next = fixture(f.server, f.store); await next.service.whenReady(); await next.service.refreshLicense();
  const renewals = f.server.requests.filter(value => value.action === 'renew');
  assert.equal(renewals.length, 2);
  for (const key of ['requestId', 'leaseToken', 'renewalId', 'nextLeaseToken']) assert.equal(renewals[0][key], renewals[1][key], key);
  assert.equal(f.store.record.licenseCache.renewal, null); assert.equal(f.store.record.licenseCache.leaseToken, renewals[0].nextLeaseToken);
  assert.equal((await next.service.getSnapshot()).license.leaseExpiresAt, expiry);
});

test('initial network failure plus exactly three background retries clears login without releasing the cloud slot',async()=>{
 const f=await signedIn();f.server.failingRenew=10;const expiry=(await f.service.getSnapshot()).license.leaseExpiresAt,deviceId=(await f.service.getSnapshot()).deviceId;
 await assert.rejects(f.service.refreshLicense());assert.equal(f.store.record.networkRetry.attempts,0);
 for(let attempt=1;attempt<=3;attempt++){
  if(attempt<3)assert.equal(f.store.record.networkRetry.nextRetryAt-f.server.now,[60000,300000,900000][attempt-1]);
  await runRetry(f);
  if(attempt<3){assert.ok((await f.service.getSnapshot()).user);assert.equal(f.store.record.networkRetry.attempts,attempt);assert.equal((await f.service.getSnapshot()).license.leaseExpiresAt,expiry);}
 }
 const state=await f.service.getSnapshot();assert.equal(state.user,null);assert.equal(state.reauthRequired,true);assert.equal(f.store.record,null);assert.match(state.error,/three network retries/i);assert.equal(f.server.devices.has(deviceId),true);
 assert.equal(f.server.requests.filter(r=>r.action==='renew').length,4);f.close();
});

test('explicit remote revocation rejects renewal immediately and cannot be bypassed by automatic claim', async () => {
  const f = await signedIn(); f.server.devices.clear(); f.server.requests.length = 0;
  await assert.rejects(f.service.refreshLicense());
  assert.ok((await f.service.getSnapshot()).user); assert.equal((await f.service.getSnapshot()).license.active,false); assert.equal(f.store.record.licenseCache.status,'device_revoked');
  assert.deepEqual(f.server.requests.map(value => value.action), ['renew']);
});

test('lease tokens, pending renewal values and activation input never enter logs or browser persistence', async () => {
  const f = await signedIn(); const token = f.store.record.licenseCache.leaseToken;
  f.server.failingRenew = 1; await assert.rejects(f.service.refreshLicense());
  const attempt = f.store.record.licenseCache.renewal, exported = f.logger.diagnostics.exportText();
  for (const secret of [token, attempt.nextLeaseToken, attempt.renewalId, attempt.requestId, 'synthetic@example.invalid', 'SYNTHETIC_ACCESS_TOKEN', 'SYNTHETIC_REFRESH_TOKEN']) {
    assert.ok(!exported.includes(secret)); assert.ok(![...f.local.values()].some(value => value.includes(secret)));
  }
  await turn();
});

test('cold restoration with refreshed authentication preserves a pending renewal operation', async () => {
  const f = await signedIn(); f.server.loseResponse = true; await assert.rejects(f.service.refreshLicense());
  const previous = structuredClone(f.store.record.licenseCache.renewal); f.close(); f.server.now += 3 * 3600_000;
  const next = fixture(f.server, f.store); await next.service.whenReady(); await next.service.refreshLicense();
  const renewals = f.server.requests.filter(value => value.action === 'renew');
  assert.equal(renewals.length, 2); assert.equal(renewals[1].requestId, previous.requestId); assert.equal(renewals[1].renewalId, previous.renewalId);
  assert.equal(f.server.requests.filter(value => value.action === 'bind').length, 1);
  assert.equal((await next.service.getSnapshot()).license.active, true);
});

test('renewal retries cannot extend access beyond the signed lease expiration', async () => {
  const server = backend(); server.leaseDuration = 10 * 60_000;
  const f = fixture(server); await f.service.whenReady(); await loginAndLink(f);
  server.failingRenew = 2; server.now += 6 * 60_000; await assert.rejects(f.service.refreshLicense());
  assert.equal((await f.service.getSnapshot()).license.active, true);
  server.now += 5 * 60_000; await assert.rejects(f.service.refreshLicense());
  const state = await f.service.getSnapshot(); assert.equal(state.license.active, false); assert.equal(state.license.status, 'lease_expired'); assert.ok(state.user);
});

test('a legacy signed cache performs the one-time token migration and then uses rotation', async () => {
  const f = await signedIn(), device = f.server.devices.get((await f.service.getSnapshot()).deviceId);
  device.legacy = true; device.leaseToken = '';
  delete f.store.record.licenseCache.leaseToken; delete f.store.record.licenseCache.renewal; delete f.store.record.licenseCache.deviceList;
  f.close(); f.server.requests.length = 0;
  const next = fixture(f.server, f.store); await next.service.whenReady(); assert.equal(f.server.requests.length, 0);
  await next.service.refreshLicense();
  assert.ok(!f.server.requests.find(value => value.action === 'renew').leaseToken);
  assert.match(f.store.record.licenseCache.leaseToken, /^[a-f0-9]{64}$/);
  await next.service.refreshLicense();
  assert.match(f.server.requests.filter(value => value.action === 'renew')[1].leaseToken, /^[a-f0-9]{64}$/);
});

test('production client and production license service agree on activation, rotation, capacity and revocation', async () => {
  const rows = new Map(); let tail = Promise.resolve();
  const repo = {transaction(action) {
    const next = tail.then(async () => {
      const draft = structuredClone(rows);
      const result = await action({get: async (collection, id) => draft.get(`${collection}/${id}`) ?? null, put: async (collection, id, value) => draft.set(`${collection}/${id}`, structuredClone(value))});
      rows.clear(); for (const [key, value] of draft) rows.set(key, value); return result;
    }); tail = next.catch(() => {}); return next;
  }};
  const signer = createSigner({privateKeyPem: privateKey.export({type: 'pkcs8', format: 'pem'}), keyId: trust.keyId, issuer: trust.issuer, audience: trust.audience, productId: trust.productId});
  const server = {now: Date.UTC(2026, 9, 20), requests: []};
  const core = createLicenseService({repo, signer, maxDevices: 2, leaseSeconds: 168 * 3600, rateLimitPerMinute: 500, now: () => server.now});
  server.call = async request => {
    server.requests.push(structuredClone(request)); const {clientTraceId, ...business} = request;
    try {return {ok: true, data: await core.handle(business, {uid: 'synthetic-user', anonymous: false})};}
    catch (error) {return {ok: false, error: {code: error.code, retryable: error.retryable}};}
  };
  const code = 'VI1-' + 'A'.repeat(64), codeHash = hash(code);
  rows.set(`${COLLECTIONS.codes}/${codeHash}`, {codeHash, productId: trust.productId, status: 'available', maxDevices: 2, features: ['app.access'], expiresAt: new Date(server.now + 30 * day).toISOString()});
  const first = fixture(server); await first.service.whenReady(); await loginAndLink(first);
  await first.service.activate(code); assert.equal((await first.service.getSnapshot()).license.active, true);
  const initialToken = first.store.record.licenseCache.leaseToken;
  await first.service.refreshLicense(); assert.notEqual(first.store.record.licenseCache.leaseToken, initialToken);
  const second = fixture(server, vault(), 'dev_synthetic_second_0123456789'); await second.service.whenReady(); await loginAndLink(second);
  assert.equal((await second.service.getSnapshot()).license.active, true);
  const third = fixture(server, vault(), 'dev_synthetic_third_0123456789'); await third.service.whenReady(); await loginAndLink(third);
  assert.equal((await third.service.getSnapshot()).license.status, 'device_limit');
  await third.service.revokeDevice((await first.service.getSnapshot()).deviceId); assert.equal((await third.service.getSnapshot()).license.active, false); assert.ok((await third.service.getSnapshot()).bindingPrompt); await third.service.bindDevice(); assert.equal((await third.service.getSnapshot()).license.active,true);
  const bindCount = server.requests.filter(value => value.action === 'bind').length;
  await assert.rejects(first.service.refreshLicense()); assert.ok((await first.service.getSnapshot()).user); assert.equal((await first.service.getSnapshot()).license.active,false); assert.equal(first.store.record.licenseCache.status,'device_revoked');
  assert.equal(server.requests.filter(value => value.action === 'bind').length, bindCount);
  const savedRows = JSON.stringify([...rows]);
  for (const secret of [initialToken, second.store.record.licenseCache.leaseToken, third.store.record.licenseCache.leaseToken]) assert.ok(!savedRows.includes(secret));
});

test('expired access with a valid signed lease starts offline without seeding expired SDK credentials', async () => {
  const f = await signedIn(), prior = structuredClone(f.store.record); f.close();
  f.server.now += 3 * 3600_000; f.server.authError = {name: 'TypeError', message: 'Failed to fetch'}; f.server.requests.length = 0;
  const next = fixture(f.server, f.store); await next.service.whenReady();
  let state = await next.service.getSnapshot(); assert.ok(state.user); assert.equal(state.license.active, true); assert.equal(state.license.status, 'valid');
  assert.equal(await next.sdkStorage().getItem('credentials_one-person-company-7dao3979fd72e'), null);
  assert.deepEqual(f.store.record, prior); assert.equal(f.server.requests.length, 0);
  f.server.authError = null; next.online(); for (let i = 0; i < 4; i++) await turn();
  state = await next.service.getSnapshot(); assert.ok(state.user); assert.equal(state.license.active, true);
  assert.equal(f.store.record.accessExpiresAt,prior.accessExpiresAt); assert.equal(f.server.requests.length,0);
  assert.equal(f.server.authCalls.restore,0);assert.equal(f.server.authCalls.refresh,0);next.close();
});

test('an explicit authentication rejection cannot retain cached offline authorization', async () => {
  const f = await signedIn(); f.close(); f.server.now += 3 * 3600_000; f.server.authError = {code: 'invalid_grant'};
  const next = fixture(f.server, f.store); await next.service.whenReady();
  assert.ok((await next.service.getSnapshot()).user);await assert.rejects(next.service.refreshLicense());
  assert.equal((await next.service.getSnapshot()).user,null);assert.equal(f.store.record,null);next.close();
});

test('background renewal preserves device-limit classification instead of replacing it with network error', async () => {
  const f = await signedIn(); f.server.rejectRenew = 'DEVICE_LIMIT_REACHED'; f.server.now += 7 * day - 4 * 60_000;
  f.online(); for (let i = 0; i < 20 && (await f.service.getSnapshot()).license.status !== 'device_limit'; i++) await turn();
  const state = await f.service.getSnapshot(); assert.equal(state.license.status, 'device_limit'); assert.equal(state.license.active, false); assert.ok(state.user);
  assert.equal(f.store.record.licenseCache.status, 'device_limit');
});

test('self-removal suppression survives partial status success, device-list failure and a cold restart', async () => {
  const f = await signedIn(), deviceId = (await f.service.getSnapshot()).deviceId;
  await f.service.revokeDevice(deviceId); f.server.failingDevices = true; f.server.requests.length = 0;
  await assert.rejects(f.service.refreshLicense());
  assert.deepEqual(f.server.requests.map(value => value.action), ['status', 'devices']);
  assert.equal(f.store.record.licenseCache.status, 'device_revoked'); assert.equal((await f.service.getSnapshot()).license.status, 'device_revoked');
  f.close(); f.server.now += 6 * 60_000;
  const restarted = fixture(f.server, f.store); await restarted.service.whenReady();
  assert.equal(f.store.record.licenseCache.status, 'device_revoked'); assert.equal((await restarted.service.getSnapshot()).license.status, 'device_revoked');
  await assert.rejects(restarted.service.refreshLicense());
  f.server.now += 6 * 60_000; restarted.online(); for (let i = 0; i < 6; i++) await turn();
  assert.equal(f.store.record.licenseCache.status, 'device_revoked'); assert.equal((await restarted.service.getSnapshot()).license.status, 'device_revoked');
  assert.ok(!f.server.requests.some(value => value.action === 'bind'));
  f.server.failingDevices = false; await restarted.service.refreshLicense();
  assert.equal((await restarted.service.getSnapshot()).license.status, 'device_revoked'); assert.ok(!f.server.requests.some(value => value.action === 'bind'));
});

test('cold restart after an expired negative cache preserves the device-limit business state', async () => {
  const server = backend(); server.add('dev_synthetic_old_01'); server.add('dev_synthetic_old_02');
  const first = fixture(server); await first.service.whenReady(); await loginAndLink(first);
  assert.equal((await first.service.getSnapshot()).license.status, 'device_limit'); first.close(); server.now += 6 * 60_000;
  const restarted = fixture(server, first.store); await restarted.service.whenReady();
  const state = await restarted.service.getSnapshot(); assert.ok(state.user); assert.equal(state.license.status, 'device_limit'); assert.equal(state.license.active, false);
  assert.equal(first.store.record.licenseCache.status, 'device_limit');
});

test('the seven-day background cycle silently refreshes authentication and renews only the existing device',async()=>{
 const f=await signedIn(),start=f.server.now,binding=(await f.service.getSnapshot()).license.bindingId;f.server.requests.length=0;
 f.server.now+=7*day-4*60000;f.online();for(let i=0;i<20&&f.server.requests.length===0;i++)await turn();for(let i=0;i<6;i++)await turn();
 assert.equal(f.server.authCalls.password,1);assert.equal(f.server.authCalls.refresh,1);assert.equal(f.store.record.sessionExpiresAt,f.server.now+7*day);
 assert.equal((await f.service.getSnapshot()).license.bindingId,binding);assert.deepEqual(f.server.requests.map(r=>r.action),['renew']);assert.equal(f.server.devices.size,1);assert.ok(f.store.record.sessionExpiresAt>start+7*day);f.close();
});

function clockedBackend() {
 const server=backend();server.clockState={schemaVersion:1,bootId:'synthetic_boot_0123456789',continuousMs:1000};return server;
}

test('native secure clock survives App restart and wall-clock rollback without a cloud check',async()=>{
  const server=clockedBackend(),first=fixture(server);await first.service.whenReady();await loginAndLink(first);
  assert.equal((await first.service.getSnapshot()).license.active,true);
  assert.equal(first.store.record.licenseClock.schemaVersion,1);
  first.close();server.clockState.continuousMs+=60_000;server.wallNow=server.now-365*day;server.requests.length=0;
  const restarted=fixture(server,first.store);await restarted.service.whenReady();
  assert.equal((await restarted.service.getSnapshot()).license.active,true);assert.equal(server.requests.length,0);
  await restarted.service.requireFeature('app.access');restarted.close();
});
test('sleeping seven days expires offline authorization despite a frozen or rolled-back system clock',async()=>{
  const server=clockedBackend(),f=fixture(server);await f.service.whenReady();await loginAndLink(f);
  server.clockState.continuousMs+=7*day;server.wallNow=server.now-day;
  await assert.rejects(f.service.requireFeature('app.access'),{code:'LICENSE_REQUIRED'});
  assert.ok((await f.service.getSnapshot()).user);assert.equal((await f.service.getSnapshot()).license.active,false);assert.ok(f.store.record);f.close();
});
test('OS reboot with an offline backend cannot restore active cached authorization or rebind',async()=>{
  const server=clockedBackend(),f=fixture(server);await f.service.whenReady();await loginAndLink(f);
  f.close();server.clockState={...server.clockState,bootId:'synthetic_boot_9876543210',continuousMs:100};server.requests.length=0;
  server.authError={name:'TypeError',message:'Failed to fetch'};
  const next=fixture(server,f.store);await next.service.whenReady();assert.equal((await next.service.getSnapshot()).license.active,false);
  await assert.rejects(next.service.requireFeature('app.access'),{code:'LICENSE_REQUIRED'});assert.ok(f.store.record);assert.equal(server.requests.length,0);next.close();
});
test('OS reboot checks the original binding and detects revocation without automatic claim',async()=>{
  const server=clockedBackend(),f=fixture(server);await f.service.whenReady();await loginAndLink(f);f.close();
  server.clockState={...server.clockState,bootId:'synthetic_boot_9876543210',continuousMs:100};server.requests.length=0;server.rejectRenew='DEVICE_REVOKED';
  const next=fixture(server,f.store);await next.service.whenReady();assert.ok((await next.service.getSnapshot()).user);assert.equal((await next.service.getSnapshot()).license.active,false);assert.equal(f.store.record.licenseCache.status,'device_revoked');
  assert.ok(server.requests.some(r=>r.action==='renew'));assert.ok(!server.requests.some(r=>r.action==='bind'));next.close();
});
test('first sign-in with an incorrect system date establishes deadlines from signed server time',async()=>{
  const server=clockedBackend();server.wallNow=server.now-365*day;
  const f=fixture(server);await f.service.whenReady();await loginAndLink(f);
  assert.equal((await f.service.getSnapshot()).license.active,true);
  assert.ok(Math.abs(f.store.record.sessionExpiresAt-(server.now+7*day))<1000);f.close();
});
test('offline restart after seven continuous days cannot revive a cached license with an earlier wall date',async()=>{
  const server=clockedBackend(),f=fixture(server);await f.service.whenReady();await loginAndLink(f);f.close();
  server.clockState.continuousMs+=7*day;server.wallNow=server.now-10*day;server.authError={name:'TypeError',message:'Failed to fetch'};
  const next=fixture(server,f.store);await next.service.whenReady();assert.ok((await next.service.getSnapshot()).user);assert.equal((await next.service.getSnapshot()).license.active,false);assert.ok(f.store.record);next.close();
});

test('license expiry is checked during a busy operation and delayed results cannot restore the expired session',async()=>{
 const server=clockedBackend(),f=fixture(server);await f.service.whenReady();await loginAndLink(f);
 const call=server.call;let release;const gate=new Promise(resolve=>{release=resolve;});server.call=async request=>{if(request.action==='devices')await gate;return call(request);};
 const loading=f.service.loadDevices(true);await turn();server.clockState.continuousMs+=7*day;
 await assert.rejects(f.service.requireFeature('app.access'),{code:'LICENSE_REQUIRED'});release();await assert.rejects(loading);
 assert.ok((await f.service.getSnapshot()).user);assert.equal((await f.service.getSnapshot()).license.active,false);assert.ok(f.store.record);f.close();
});
test('an old cache without a clock anchor requires one online upgrade without replacing its binding',async()=>{
 const server=clockedBackend(),f=fixture(server);await f.service.whenReady();await loginAndLink(f);
 const binding=(await f.service.getSnapshot()).license.bindingId;f.close();delete f.store.record.licenseClock;server.requests.length=0;
 const next=fixture(server,f.store);await next.service.whenReady();assert.equal((await next.service.getSnapshot()).license.bindingId,binding);
 assert.ok(server.requests.some(r=>r.action==='renew'));assert.ok(!server.requests.some(r=>r.action==='bind'));assert.ok(f.store.record.licenseClock);next.close();
});
test('OS reboot with a forward-adjusted wall clock still preserves the original session deadline',async()=>{
 const server=clockedBackend(),f=fixture(server);await f.service.whenReady();await loginAndLink(f);const deadline=f.store.record.sessionExpiresAt;
 f.close();server.clockState={...server.clockState,bootId:'synthetic_boot_9876543210',continuousMs:100};server.wallNow=server.now+365*day;
 const next=fixture(server,f.store);await next.service.whenReady();assert.equal((await next.service.getSnapshot()).license.active,true);assert.equal(f.store.record.sessionExpiresAt,deadline);next.close();
});

test('legacy token-only sessions migrate using signed server time when the system date is incorrect',async()=>{
 const server=clockedBackend(),store=vault();store.record={schemaVersion:1,envId:'one-person-company-7dao3979fd72e',accessToken:'SYNTHETIC_ACCESS_TOKEN',refreshToken:'SYNTHETIC_REFRESH_TOKEN'};server.wallNow=server.now-365*day;
 const next=fixture(server,store);await next.service.whenReady();assert.equal((await next.service.getSnapshot()).license.active,false);assert.ok((await next.service.getSnapshot()).bindingPrompt);await next.service.bindDevice();assert.equal(store.record.schemaVersion,2);assert.ok(store.record.licenseClock);assert.ok(Math.abs(store.record.sessionExpiresAt-(server.now+7*day))<1000);next.close();
});

test('native automatic sessions cross three weekly renewals with no password and one license invocation each cycle',async()=>{
 const server=clockedBackend(),f=fixture(server);await f.service.whenReady();await loginAndLink(f);
 const binding=(await f.service.getSnapshot()).license.bindingId;server.requests.length=0;
 for(let cycle=1;cycle<=3;cycle++){
  const delta=7*day-4*60000;server.now+=delta;server.clockState.continuousMs+=delta;f.online();
  for(let i=0;i<20&&(server.requests.length<cycle||f.store.record.licenseCache.renewal);i++)await turn();
  assert.equal((await f.service.getSnapshot()).license.active,true);assert.equal((await f.service.getSnapshot()).license.bindingId,binding);
  assert.equal(server.authCalls.password,1);assert.equal(server.authCalls.refresh,cycle);assert.equal(server.devices.size,1);
  assert.ok(Math.abs(f.store.record.sessionExpiresAt-(server.now+7*day))<1000);
 }
 assert.deepEqual(server.requests.map(r=>r.action),['renew','renew','renew']);f.close();
});
test('daily native restarts, foreground changes and local feature checks make zero requests despite expired access tokens',async()=>{
 const server=clockedBackend();let f=fixture(server);await f.service.whenReady();await loginAndLink(f);
 const store=f.store,original=JSON.stringify(store.record);f.close();server.requests.length=0;
 for(let dayIndex=1;dayIndex<=6;dayIndex++){
  server.now+=day;server.clockState.continuousMs+=day;f=fixture(server,store);await f.service.whenReady();f.online();await turn();await f.service.requireFeature('app.access');
  assert.equal((await f.service.getSnapshot()).license.active,true);assert.equal(JSON.stringify(store.record),original);f.close();
 }
 assert.equal(server.requests.length,0);assert.equal(server.authCalls.restore,0);assert.equal(server.authCalls.refresh,0);assert.equal(server.authCalls.password,1);
});
test('an expired offline native window retains credentials and resumes automatically when connectivity returns',async()=>{
 const server=clockedBackend(),first=fixture(server);await first.service.whenReady();await loginAndLink(first);first.close();
 const store=first.store,deadline=store.record.sessionExpiresAt;server.now+=8*day;server.clockState.continuousMs+=8*day;server.authError={name:'TypeError',message:'Failed to fetch'};
 const next=fixture(server,store);await next.service.whenReady();assert.ok(store.record);assert.ok((await next.service.getSnapshot()).user);await assert.rejects(next.service.requireFeature('app.access'),{code:'LICENSE_REQUIRED'});
 assert.equal(store.record.sessionExpiresAt,deadline);server.authError=null;server.requests.length=0;await runRetry({...next,server});
 for(let i=0;i<20&&!(await next.service.getSnapshot()).license.active;i++)await turn();
 assert.equal((await next.service.getSnapshot()).license.active,true);assert.equal(server.authCalls.password,1);assert.deepEqual(server.requests.map(r=>r.action),['renew']);assert.ok(store.record.sessionExpiresAt>deadline);next.close();
});
test('weekly silent recovery cannot bypass a device revoked during the offline interval',async()=>{
 const server=clockedBackend(),first=fixture(server);await first.service.whenReady();await loginAndLink(first);first.close();server.devices.clear();
 server.now+=8*day;server.clockState.continuousMs+=8*day;server.requests.length=0;const next=fixture(server,first.store);await next.service.whenReady();
 assert.ok((await next.service.getSnapshot()).user);assert.equal((await next.service.getSnapshot()).license.active,false);assert.equal(first.store.record.licenseCache.status,'device_revoked');assert.equal(server.authCalls.password,1);assert.deepEqual(server.requests.map(r=>r.action),['renew']);next.close();
});

test('new installations ask for consent and cancellation survives checks and restart without consuming a slot',async()=>{
 const server=backend(),f=fixture(server);await f.service.whenReady();await f.service.login('synthetic@example.invalid','SyntheticPassword123');
 let state=await f.service.getSnapshot();assert.ok(state.user);assert.equal(state.license.active,false);assert.equal(state.bindingPrompt.used,0);assert.equal(state.bindingPrompt.maximum,2);assert.equal(server.devices.size,0);assert.ok(!server.requests.some(r=>r.action==='bind'));
 f.service.dismissDeviceBinding();await assert.rejects(f.service.bindDevice());await f.service.refreshLicense();assert.equal((await f.service.getSnapshot()).bindingPrompt,null);assert.equal(server.devices.size,0);
 f.close();server.requests.length=0;const next=fixture(server,f.store);await next.service.whenReady();assert.equal((await next.service.getSnapshot()).bindingPrompt,null);assert.equal(server.requests.length,0);
 await next.service.requestDeviceBinding();assert.ok((await next.service.getSnapshot()).bindingPrompt);await next.service.bindDevice();assert.equal((await next.service.getSnapshot()).license.active,true);assert.equal(server.devices.size,1);
 await next.service.login('synthetic@example.invalid','SyntheticPassword123');assert.equal((await next.service.getSnapshot()).bindingPrompt,null);assert.equal((await next.service.getSnapshot()).license.active,true);assert.equal(server.devices.size,1);next.close();
});
test('capacity is checked again by the backend after consent and cannot exceed the latest configured limit',async()=>{
 const server=backend(),f=fixture(server);await f.service.whenReady();await f.service.login('synthetic@example.invalid','SyntheticPassword123');assert.ok((await f.service.getSnapshot()).bindingPrompt);
 server.add('dev_synthetic_competing_01');server.maxDevices=1;await assert.rejects(f.service.bindDevice());
 const state=await f.service.getSnapshot();assert.equal(state.license.status,'device_limit');assert.equal(state.license.active,false);assert.equal(state.bindingPrompt,null);assert.equal(server.devices.size,1);assert.ok(state.user);f.close();
});
test('device-list network failures share one three-retry budget even when online events and other requests also fail',async()=>{
 const f=await signedIn();f.server.failingDevices=true;await assert.rejects(f.service.loadDevices(true));await assert.rejects(f.service.loadDevices(true));f.online();f.online();
 assert.equal(f.store.record.networkRetry.attempts,0);assert.equal([...f.timers.values()].filter(v=>v.callback.toString().includes('retryNetworkInBackground')).length,1);
 for(let i=0;i<3;i++)await runRetry(f);
 assert.equal((await f.service.getSnapshot()).user,null);assert.equal(f.store.record,null);assert.ok(f.logger.diagnostics.getEntries().some(e=>e.resultCode==='NETWORK_RETRIES_EXHAUSTED'));f.close();
});
test('successful recovery before the third retry resets the budget and retains the same device lease',async()=>{
 const f=await signedIn(),binding=(await f.service.getSnapshot()).license.bindingId;f.server.failingDevices=true;await assert.rejects(f.service.loadDevices(true));await runRetry(f);assert.equal(f.store.record.networkRetry.attempts,1);
 f.server.failingDevices=false;await runRetry(f);assert.ok((await f.service.getSnapshot()).user);assert.equal(f.store.record.networkRetry,undefined);assert.equal((await f.service.getSnapshot()).license.bindingId,binding);
 f.server.failingDevices=true;await assert.rejects(f.service.loadDevices(true));assert.equal(f.store.record.networkRetry.attempts,0);f.close();
});
test('the persisted retry count survives process restart and cannot gain another three attempts',async()=>{
 const f=await signedIn();f.server.failingRenew=10;await assert.rejects(f.service.refreshLicense());await runRetry(f);await runRetry(f);assert.equal(f.store.record.networkRetry.attempts,2);f.close();
 const next=fixture(f.server,f.store);await next.service.whenReady();assert.equal(f.store.record.networkRetry.attempts,2);await runRetry({...next,server:f.server});
 assert.equal((await next.service.getSnapshot()).user,null);assert.equal(f.store.record,null);assert.equal(f.server.requests.filter(r=>r.action==='renew').length,4);next.close();
});
test('authentication refresh failures also exhaust three retries without issuing a license mutation',async()=>{
 const f=await signedIn();f.server.now+=3*3600_000;f.server.authError={name:'TypeError',message:'Failed to fetch'};f.server.requests.length=0;
 await assert.rejects(f.service.loadDevices(true));for(let i=0;i<3;i++)await runRetry(f);
 assert.equal((await f.service.getSnapshot()).user,null);assert.equal(f.store.record,null);assert.equal(f.server.requests.length,0);assert.equal(f.server.authCalls.refresh,4);f.close();
});
test('logout cancels scheduled recovery and late retry callbacks cannot restore a former account',async()=>{
 const f=await signedIn();f.server.failingDevices=true;await assert.rejects(f.service.loadDevices(true));const callback=[...f.timers.values()].find(v=>v.callback.toString().includes('retryNetworkInBackground')).callback;
 await f.service.logout();const count=f.server.requests.length;callback();for(let i=0;i<10;i++)await turn();assert.equal(f.server.requests.length,count);assert.equal((await f.service.getSnapshot()).user,null);assert.equal(f.store.record,null);f.close();
});
test('legacy token-only restore failures use the same bounded recovery without requiring a cached user',async()=>{
 const server=backend({licensed:false}),store=vault();store.record={schemaVersion:1,envId:'one-person-company-7dao3979fd72e',accessToken:'SYNTHETIC_ACCESS_TOKEN',refreshToken:'SYNTHETIC_REFRESH_TOKEN'};server.authError={name:'TypeError',message:'Failed to fetch'};
 const f=fixture(server,store);await f.service.whenReady();assert.ok(store.record);assert.equal((await f.service.getSnapshot()).user,null);
 // v1 has no metadata extension; the running recovery still has a bounded timer.
 for(let i=0;i<3;i++){const timer=[...f.timers.entries()].find(([,v])=>v.callback.toString().includes('retryNetworkInBackground'));assert.ok(timer);f.timers.delete(timer[0]);server.now+=timer[1].delay;timer[1].callback();for(let n=0;n<40;n++)await turn();}
 assert.equal(store.record,null);assert.equal((await f.service.getSnapshot()).reauthRequired,true);assert.equal(server.authCalls.restore,4);f.close();
});

test('an explicit provider session rejection during network recovery exits immediately rather than consuming the remaining retries',async()=>{
 const f=await signedIn();f.server.now+=3*3600_000;f.server.authError={name:'TypeError',message:'Failed to fetch'};await assert.rejects(f.service.refreshLicense());
 f.server.authError={code:'invalid_grant'};await runRetry(f);assert.equal((await f.service.getSnapshot()).user,null);assert.equal(f.store.record,null);assert.equal(f.server.authCalls.refresh,2);f.close();
});
test('a definitive capacity response during recovery ends the network retry loop and keeps account management available',async()=>{
 const f=await signedIn();f.server.failingDevices=true;await assert.rejects(f.service.loadDevices(true));f.server.failingDevices=false;f.server.rejectRenew='DEVICE_LIMIT_REACHED';await runRetry(f);
 const state=await f.service.getSnapshot();assert.ok(state.user);assert.equal(state.license.status,'device_limit');assert.equal(state.reauthRequired,false);assert.equal(f.store.record.networkRetry,undefined);f.close();
});
test('a restart after the third attempt was persisted cannot start a fourth background request',async()=>{
 const f=await signedIn();f.server.failingDevices=true;await assert.rejects(f.service.loadDevices(true));f.store.record.networkRetry.attempts=3;f.close();f.server.requests.length=0;
 const next=fixture(f.server,f.store);await next.service.whenReady();assert.equal((await next.service.getSnapshot()).user,null);assert.equal((await next.service.getSnapshot()).reauthRequired,true);assert.equal(f.store.record,null);assert.equal(f.server.requests.length,0);next.close();
});

test('explicit timeout codes without SDK retryable metadata still use all three background attempts',async()=>{
 const f=await signedIn(),call=f.server.call;f.server.call=async request=>{if(request.action==='devices')throw {code:'NETWORK_TIMEOUT'};return call(request);};
 await assert.rejects(f.service.loadDevices(true));for(let i=0;i<3;i++)await runRetry(f);
 assert.equal((await f.service.getSnapshot()).user,null);assert.equal((await f.service.getSnapshot()).reauthRequired,true);assert.equal(f.store.record,null);f.close();
});


test('a lease clipped to entitlement expiry waits for that deadline, preserves login and does not loop renewals',async()=>{
 const server=backend();server.entitlementExpiresAt=server.now+4*60_000;
 const f=fixture(server);await f.service.whenReady();await loginAndLink(f);
 const deadline=f.store.record.sessionExpiresAt;
 assert.equal((await f.service.getSnapshot()).license.active,true);
 const checks=[...f.timers.values()].filter(t=>t.callback.toString().includes('refreshInBackground'));
 assert.ok(checks.length);assert.equal(Math.min(...checks.map(t=>t.delay)),4*60_000);
 server.requests.length=0;server.now+=60_000;f.online();for(let i=0;i<8;i++)await turn();assert.equal(server.requests.length,0);
 server.now=server.entitlementExpiresAt+1;await assert.rejects(f.service.refreshLicense());
 const state=await f.service.getSnapshot();assert.ok(state.user);assert.equal(state.license.active,false);assert.equal(state.license.status,'expired');
 assert.equal(f.store.record.sessionExpiresAt,deadline);assert.equal(f.store.record.licenseCache.status,'expired');assert.equal(server.requests.length,1);
 for(let i=0;i<3;i++){f.online();await turn();}assert.equal(server.requests.length,1);
 f.close();server.requests.length=0;const restarted=fixture(server,f.store);await restarted.service.whenReady();assert.ok((await restarted.service.getSnapshot()).user);assert.equal(server.requests.length,0);restarted.close();
});

test('an invalid renewed certificate removes authorization but retains the authenticated account and encrypted session',async()=>{
 const f=await signedIn(),original=f.server.call;
 f.server.call=async req=>{const result=await original(req);if(req.action==='renew'&&result.ok)result.data.certificate={...result.data.certificate,signature:'bad-signature'};return result;};
 await assert.rejects(f.service.refreshLicense());const state=await f.service.getSnapshot();
 assert.ok(state.user);assert.equal(state.license.active,false);assert.equal(state.license.status,'invalid');assert.ok(f.store.record);
 assert.equal(f.store.record.licenseCache.certificate,null);assert.equal(f.store.record.licenseCache.leaseToken,'');
 await assert.rejects(f.service.requireFeature('app.access'),{code:'LICENSE_REQUIRED'});f.close();
});

test('short server leases schedule a spaced renewal instead of an already-past five-minute safety time',async()=>{
 const server=backend();server.leaseDuration=60_000;const f=fixture(server);await f.service.whenReady();await loginAndLink(f);
 const checks=[...f.timers.values()].filter(t=>t.callback.toString().includes('refreshInBackground'));
 assert.equal(Math.min(...checks.map(t=>t.delay)),30_000);f.close();
});
