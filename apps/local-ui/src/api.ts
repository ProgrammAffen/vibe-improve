import cloudbase from '@cloudbase/js-sdk';
import trust from '../../../cloud/public-license-key.json';
import {verifyLicenseCertificate, verifyServerTimeProof} from '../../../packages/license/verify-certificate.mjs';
import {TrustedLicenseClock, validClockAnchor, type ClockAnchor, type ClockSample} from '../../../packages/license/trusted-clock.mjs';
import {diagnosticSpan, diagnoseError, type DiagnosticEntry, type DiagnosticOperation} from './logger';
import {passwordValid} from './password-validation';

declare global {
  interface Window {
    vibeNative?: {agents?: {request: (action: string, value?: Record<string,unknown>) => Promise<unknown>}; projects?: {request: (action: string, value?: Record<string,unknown>) => Promise<unknown>}; clock?: {sample: () => Promise<ClockSample>}; deviceId: string; deviceName?: string; preferences: Record<string, unknown>; setPreferences: (value: Record<string, unknown>) => void; quit: () => void; log?: (entry: DiagnosticEntry) => void; session?: {read: () => Promise<unknown>; write: (value: unknown) => Promise<unknown>; clear: () => Promise<unknown>}};
  }
}
export type Snapshot = {
  user: null | {id: string; email: string; nickname: string};
  license: any;
  devices: any[];
  devicesState: 'idle' | 'loading' | 'ready' | 'error';
  devicesError: string | null;
  devicesMaxDevices: number | null;
  busy: boolean;
  restoring: boolean;
  error: string | null;
  configured: boolean;
  deviceId: string;
  bindingPrompt: null | {used: number; maximum: number};
  reauthRequired: boolean;
};
const memory = new Map<string, string>();
let sdkDeviceIdentity: Promise<string> | undefined;
function stableSDKDeviceId() {
  return sdkDeviceIdentity ??= (async () => {
    if (sdkDeviceHeader) return sdkDeviceHeader;
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('vibe-improve:oauth-device:v1:'+installationId())));
    const bytes=digest.slice(0,16);bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
    const hex=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  })();
}
const storage = {
  getItem: async (key: string) => memory.get(key) ?? (key==='device_id' ? await stableSDKDeviceId() : null),
  setItem: async (key: string, value: string) => {memory.set(key, value);},
  removeItem: async (key: string) => {memory.delete(key);},
  getItemSync: (key: string) => memory.get(key) ?? null,
  setItemSync: (key: string, value: string) => {memory.set(key, value);},
  removeItemSync: (key: string) => {memory.delete(key);},
};
const appDeviceId=installationId();
const sdkDeviceHex=appDeviceId.replace(/[-_]/g,'').slice(-32).toLowerCase();
const sdkDeviceHeader=/^[a-f0-9]{32}$/.test(sdkDeviceHex) ? `${sdkDeviceHex.slice(0,8)}-${sdkDeviceHex.slice(8,12)}-4${sdkDeviceHex.slice(13,16)}-8${sdkDeviceHex.slice(17,20)}-${sdkDeviceHex.slice(20)}` : undefined;
const app = cloudbase.init({env: 'one-person-company-7dao3979fd72e', region: 'ap-shanghai', persistence: 'none'});
const auth = app.auth({persistence: 'none', storage,headers:{...(sdkDeviceHeader&&{'x-device-id':sdkDeviceHeader})}} as Parameters<typeof app.auth>[0] & {storage: typeof storage});
const listeners = new Set<(value: Snapshot) => void>();
function installationId() {
  if (window.vibeNative?.deviceId) return window.vibeNative.deviceId;
  try {
    const stored = localStorage.getItem('vibe-improve.installation');
    if (stored && /^[A-Za-z0-9_-]{16,128}$/.test(stored)) return stored;
    const id = crypto.randomUUID();
    localStorage.setItem('vibe-improve.installation', id);
    return id;
  } catch {return crypto.randomUUID();}
}
let snapshot: Snapshot = {user: null, license: null, devices: [], devicesState: 'idle', devicesError: null, devicesMaxDevices: null, busy: false, restoring: false, error: null, configured: true, deviceId: appDeviceId, bindingPrompt: null, reauthRequired: false};
let registration: null | {email: string; verify: (token: string) => Promise<unknown>} = null;
let resetChallenge: null | ((nonce: string, password: string) => Promise<unknown>) = null;
let changeChallenge: null | ((nonce: string, password: string) => Promise<unknown>) = null;
let certificate: any = null;
let generation = 0;
let activeOperation: {traceId: string; name: DiagnosticOperation} | undefined;
let lastIdentityRefresh = 0;
let renewal: ReturnType<typeof setTimeout> | undefined;
let licenseJob: {generation: number; promise: Promise<void>} | null = null;
let devicesJob: {generation: number; promise: Promise<void>} | null = null;
let devicesCheckedAt = 0;
const pending = new Map<string, string>();
const nativeSession = window.vibeNative?.session;
const nativeClock = window.vibeNative?.clock;
const secureTiming = Boolean(nativeClock);
const licenseClock = new TrustedLicenseClock({sample: async () => {if (!nativeClock) throw {code:'LICENSE_CLOCK_UNTRUSTED'}; return nativeClock.sample();}});
const licenseNow = () => secureTiming && licenseClock.trusted ? licenseClock.now() : Date.now();
let sessionNeedsClock = false;
let clockTimer: ReturnType<typeof setTimeout> | undefined;
let clockJob: Promise<void> | null = null;
let sessionWritesEnabled = false;
let sessionQueue: Promise<unknown> = Promise.resolve();
type SavedSessionV1 = {schemaVersion: 1; envId: string; accessToken: string; refreshToken: string};
type LeaseRenewal = {requestId: string; renewalId: string; nextLeaseToken: string; startedAt: number; retryCount: number; nextRetryAt: number};
type CachedDevice = {deviceId: string; bindingId: string; deviceName: string; lastSeenAt: string};
type DeviceListCache = {checkedAt: number; userId: string; licenseId: string; maxDevices: number; devices: CachedDevice[]};
type LicenseCache = {checkedAt: number; status: string; certificate: any; bindingId: string; licenseId: string; maxDevices: number; leaseToken?: string; renewal?: LeaseRenewal | null; deviceList?: DeviceListCache | null};
type NetworkRetry = {attempts: number; nextRetryAt: number; refreshDevices: boolean};
type SavedSessionV2 = {schemaVersion: 2; envId: string; accessToken: string; refreshToken: string; accessExpiresAt: number; sessionExpiresAt: number; validatedAt: number; user: NonNullable<Snapshot['user']>; scope: string; licenseCache: LicenseCache | null; licenseClock?: ClockAnchor | null; networkRetry?: NetworkRetry};
type SavedSession = SavedSessionV1 | SavedSessionV2;
const SESSION_MAX_AGE = 7 * 24 * 60 * 60_000;
const REFRESH_AHEAD = 60_000;
const LICENSE_STATUS_MAX_AGE = SESSION_MAX_AGE;
const DEVICE_LIST_MAX_AGE = 60_000;
const LEASE_RENEWAL_INTERVAL = 168 * 60 * 60_000;
const LEASE_SAFETY_WINDOW = 5 * 60_000;
const LEASE_RETRY_DELAY = 60_000;
const MAX_RETRY_COUNT = 3;
const retryDelay = (count: number) => [60_000, 5*60_000, 15*60_000][Math.min(Math.max(count-1,0),2)];
const SDK_CREDENTIAL_KEY = 'credentials_one-person-company-7dao3979fd72e';
let savedSession: SavedSession | null = null;
let licenseCache: LicenseCache | null = null;
let deviceListCache: DeviceListCache | null = null;
let nextLicenseCheckAt = 0;
let leaseToken = '';
let leaseRenewal: LeaseRenewal | null = null;
let sessionRefreshJob: Promise<void> | null = null;
let sessionExpiryTimer: ReturnType<typeof setTimeout> | undefined;
let sdkNeedsRestore = false;
let nextSessionRetryAt = 0;
let networkRetry: NetworkRetry | null = null;
let networkRetryTimer: ReturnType<typeof setTimeout> | undefined;
let networkRetryJob: Promise<void> | null = null;
let networkFailureVersion = 0;
const networkFailureCodes = ['NETWORK_OFFLINE','NETWORK_TIMEOUT','NETWORK_UNREACHABLE','SERVICE_UNAVAILABLE','DATABASE_UNAVAILABLE'];
function validNetworkRetry(value: any): value is NetworkRetry {
  return value && Object.keys(value).sort().join(',') === 'attempts,nextRetryAt,refreshDevices' && Number.isInteger(value.attempts) && value.attempts >= 0 && value.attempts <= MAX_RETRY_COUNT && Number.isSafeInteger(value.nextRetryAt) && value.nextRetryAt > 0 && typeof value.refreshDevices === 'boolean';
}
function sessionRecord(accessToken: unknown, refreshToken: unknown): SavedSessionV1 {
  const valid = (value: unknown): value is string => typeof value === 'string' && /^[\x21-\x7e]{8,16384}$/.test(value);
  if (!valid(accessToken) || !valid(refreshToken)) throw {code: 'SESSION_STORAGE_INVALID'};
  return {schemaVersion: 1, envId: 'one-person-company-7dao3979fd72e', accessToken, refreshToken};
}
function expiry(value: any): number {
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  return value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : NaN;
}
function displayUser(user: any): NonNullable<Snapshot['user']> | null {
  if (!user || user.is_anonymous || typeof user.id !== 'string' || !user.id || user.id.length > 256) return null;
  const email = String(user.email ?? ''), nickname = String(user.nickname ?? user.user_metadata?.name ?? user.user_metadata?.nickName ?? '');
  if (email.length > 320 || nickname.length > 256 || /[\x00-\x1f\x7f]/.test(user.id + email + nickname)) return null;
  return {id: user.id, email, nickname};
}
function makeSavedSession(session: any): SavedSession {
  const basic = sessionRecord(session?.access_token, session?.refresh_token);
  const user = displayUser(session?.user) ?? snapshot.user;
  const continuing = savedSession?.schemaVersion === 2 && savedSession.user.id === user?.id ? savedSession : null;
  const now = secureTiming && !licenseClock.trusted && continuing ? continuing.validatedAt : licenseNow();
  let accessExpiresAt = expiry(session?.expires_at);
  const seconds = session?.expires_in;
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) accessExpiresAt = secureTiming ? now + seconds * 1000 : Math.min(Number.isFinite(accessExpiresAt) ? accessExpiresAt : Infinity, now + seconds * 1000);
  if (!user || !Number.isSafeInteger(accessExpiresAt) || accessExpiresAt <= now) return basic;
  const record: SavedSessionV2 = {...basic, schemaVersion: 2, accessExpiresAt, sessionExpiresAt: secureTiming && !licenseClock.trusted && continuing ? continuing.sessionExpiresAt : now + SESSION_MAX_AGE, validatedAt: secureTiming && !licenseClock.trusted && continuing ? continuing.validatedAt : now, user, scope: typeof session?.scope === 'string' ? session.scope : '', licenseCache};
  if (record.scope.length > 1024 || JSON.stringify(record).length > 40_000) throw {code: 'SESSION_STORAGE_INVALID'};
  return record;
}
function validateSavedSession(value: any): SavedSession {
  if (!value || value.envId !== 'one-person-company-7dao3979fd72e') throw {code: 'SESSION_STORAGE_INVALID'};
  const basic = sessionRecord(value.accessToken, value.refreshToken);
  if (value.schemaVersion === 1 && Object.keys(value).length === 4) return basic;
  const user = displayUser(value.user);
  const extraFields = Number(Object.hasOwn(value, 'licenseClock')) + Number(Object.hasOwn(value, 'networkRetry'));
  if (value.schemaVersion !== 2 || Object.keys(value).length !== 10 + extraFields || !user || Object.keys(value.user).sort().join(',') !== 'email,id,nickname' ||
      !['accessExpiresAt', 'sessionExpiresAt', 'validatedAt'].every(key => Number.isSafeInteger(value[key]) && value[key] > 0) ||
      value.sessionExpiresAt <= value.validatedAt || value.sessionExpiresAt - value.validatedAt > SESSION_MAX_AGE ||
      typeof value.scope !== 'string' || value.scope.length > 1024 || JSON.stringify(value).length > 40_000) throw {code: 'SESSION_STORAGE_INVALID'};
  if (Object.hasOwn(value, 'licenseClock') && !(value.licenseClock === null || validClockAnchor(value.licenseClock))) throw {code: 'SESSION_STORAGE_INVALID'};
  if (Object.hasOwn(value, 'networkRetry') && !validNetworkRetry(value.networkRetry)) throw {code: 'SESSION_STORAGE_INVALID'};
  return {...value, ...basic, schemaVersion: 2, user};
}
function seedSDKSession(record: SavedSessionV2) {
  memory.set(SDK_CREDENTIAL_KEY, JSON.stringify({access_token: record.accessToken, refresh_token: record.refreshToken, expires_at: new Date(record.accessExpiresAt).toISOString(), expires_in: Math.max(1, Math.floor((record.accessExpiresAt - Date.now()) / 1000)), token_type: 'Bearer', scope: record.scope || undefined}));
}
async function persistCurrentSession(token = generation): Promise<string> {
  if (!nativeSession || token !== generation) return '';
  try {
    await sessionTask('persist', async () => {
      if (token !== generation || !savedSession) return;
      if (savedSession.schemaVersion === 2) {
        const {networkRetry: _previousRetry, ...record} = savedSession;
        savedSession = {...record, licenseCache, ...(secureTiming && {licenseClock: licenseClock.record()}), ...(networkRetry && {networkRetry: {...networkRetry}})};
      }
      await nativeSession.write(savedSession);
    });
    return '';
  } catch (cause) {return message(cause);}
}

function sessionTask<T>(kind: 'restore' | 'persist' | 'clear', action: () => Promise<T>): Promise<T> {
  const result = sessionQueue.then(async () => {
    const span = diagnosticSpan(`auth.session.${kind}`, 'operation', undefined, {stage: `auth.session.${kind}`});
    try {const value = await action(); span.succeed(); return value;}
    catch (cause: any) {
      const code = cause?.code === 'SESSION_STORAGE_INVALID' || cause?.message === 'SESSION_STORAGE_INVALID' ? 'SESSION_STORAGE_INVALID' : 'SESSION_STORAGE_UNAVAILABLE';
      span.fail({code}); throw {code};
    }
  });
  sessionQueue = result.catch(() => {});
  return result;
}
async function rememberSession(session: any, token = generation): Promise<string> {
  if (token !== generation) return '';
  try {if (secureTiming && !licenseClock.trusted) sessionNeedsClock = true; savedSession = makeSavedSession(session); scheduleSessionExpiry();}
  catch (cause) {return message(cause);}
  return persistCurrentSession(token);
}
async function forgetSession() {
  if (sessionExpiryTimer) clearTimeout(sessionExpiryTimer);
  sessionExpiryTimer = undefined;
  if (clockTimer) clearTimeout(clockTimer);
  clockTimer = undefined; sessionNeedsClock = false;
  resetNetworkRetry();
  savedSession = null; licenseCache = null; nextLicenseCheckAt = 0; leaseToken = ''; leaseRenewal = null; sdkNeedsRestore = false; nextSessionRetryAt = 0;
  if (nativeSession) await sessionTask('clear', () => nativeSession.clear());
}
async function invalidateSession() {
  generation++; sessionWritesEnabled = false;
  clearAuthorization(); memory.clear();
  registration = null; resetChallenge = null; changeChallenge = null;
  try {await forgetSession();} finally {publish({user: null, bindingPrompt: null});}
}
function resetNetworkRetry() {
  if (networkRetryTimer) clearTimeout(networkRetryTimer);
  networkRetryTimer = undefined; networkRetry = null;
}
function scheduleNetworkRetry() {
  if (networkRetryTimer) clearTimeout(networkRetryTimer);
  networkRetryTimer = undefined;
  if (!networkRetry || (!snapshot.user && !savedSession)) return;
  const token = generation;
  const delay = secureTiming && !licenseClock.trusted ? LEASE_RETRY_DELAY : networkRetry.nextRetryAt - licenseNow();
  networkRetryTimer = setTimeout(() => {networkRetryTimer = undefined; void retryNetworkInBackground(token);}, Math.max(1_000, Math.min(2_147_483_647, delay)));
}
async function queueNetworkRetry(cause: unknown, token: number, refreshDevices = false) {
  const detail = diagnoseError(cause);
  if (token !== generation || (!snapshot.user && !savedSession) || !networkFailureCodes.includes(detail.resultCode)) return;
  networkFailureVersion++;
  if (networkRetry) networkRetry.refreshDevices ||= refreshDevices;
  else networkRetry = {attempts: 0, nextRetryAt: licenseNow() + retryDelay(1), refreshDevices};
  if (!networkRetryJob) {
    const warning = await persistCurrentSession(token);
    if (warning) {await invalidateSession(); return;}
    scheduleNetworkRetry();
  }
}
async function expireNetworkSession(token: number) {
  if (token !== generation) return;
  const span = diagnosticSpan('auth.session.refresh', 'background', undefined, {stage:'auth.session.refresh'});
  span.fail({code:'NETWORK_RETRIES_EXHAUSTED'});
  let storageError = false;
  try {await invalidateSession();} catch {storageError = true;}
  finally {publish({reauthRequired: true, error: [message({code:'NETWORK_RETRIES_EXHAUSTED'}),storageError ? message({code:'SESSION_STORAGE_UNAVAILABLE'}) : ''].filter(Boolean).join('\n')});}
}
async function retryNetworkInBackground(token: number) {
  if (token !== generation || !networkRetry || networkRetryJob) return;
  if (snapshot.busy || snapshot.restoring || licenseJob || sessionRefreshJob || devicesJob) {networkRetry.nextRetryAt = licenseNow() + 5_000; scheduleNetworkRetry(); return;}
  if (networkRetry.attempts >= MAX_RETRY_COUNT) {await expireNetworkSession(token); return;}
  const job = (async () => {
    const failureVersion = networkFailureVersion;
    networkRetry!.attempts++;
    const warning = await persistCurrentSession(token);
    if (warning) {await invalidateSession(); return;}
    const span = diagnosticSpan('auth.session.refresh','background',undefined,{stage:'auth.session.refresh'});
    try {
      if (!snapshot.user && savedSession) {
        const data = await authRequest('auth.session.restore',()=>auth.setSession({access_token:savedSession!.accessToken,refresh_token:savedSession!.refreshToken}),'auth.session.restore');
        const identity = displayUser(data.user) ?? displayUser((await authRequest('auth.identity.read',()=>auth.getUser(),'auth.identity.read')).user);
        if (token !== generation) return;
        if (!identity) {await invalidateSession(); return;}
        publish({user:identity}); sessionWritesEnabled = true; sdkNeedsRestore = false;
        await rememberSession({...data.session,user:identity},token);
      }
      if (networkRetry?.refreshDevices) await loadDevices(true);
      await refreshLicenseInternal(false, false, true);
      if (token !== generation) return;
      if (!snapshot.user || !networkRetry) return;
      if (failureVersion !== networkFailureVersion) throw {code:'NETWORK_UNREACHABLE'};
      resetNetworkRetry(); nextSessionRetryAt = 0;
      await saveLicenseCache(token);
      scheduleSessionExpiry();
      scheduleLicenseCheck(nextLicenseCheckAt || licenseNow() + LICENSE_STATUS_MAX_AGE);
      publish({error:null}); span.succeed();
    } catch (cause) {
      span.fail(cause);
      if (token !== generation || !networkRetry) return;
      const detail = diagnoseError(cause);
      if (['SESSION_INVALID','AUTH_REQUIRED','INVALID_CREDENTIALS','AUTH_USER_BLOCKED','AUTH_USER_NOT_FOUND'].includes(detail.resultCode)) {await invalidateSession(); publish({error:message(cause)}); return;}
      if (!detail.retryable && !networkFailureCodes.includes(detail.resultCode)) {
        resetNetworkRetry(); await persistCurrentSession(token);
        publish({error:message(cause)}); scheduleSessionExpiry(); scheduleLicenseCheck(nextLicenseCheckAt || licenseNow() + LICENSE_STATUS_MAX_AGE); return;
      }
      if (networkRetry.attempts >= MAX_RETRY_COUNT) {await expireNetworkSession(token); return;}
      networkRetry.nextRetryAt = licenseNow() + retryDelay(networkRetry.attempts + 1);
      const warning = await persistCurrentSession(token);
      if (warning) {await invalidateSession(); publish({error:warning}); return;}
      scheduleNetworkRetry();
    }
  })();
  networkRetryJob = job;
  try {await job;} finally {if (networkRetryJob === job) networkRetryJob = null;}
}
async function ensureFreshSession() {
  if (!snapshot.user) throw {code: 'AUTH_REQUIRED'};
  const current = savedSession, now = licenseNow(), clockUnknown = secureTiming && !licenseClock.trusted;
  if (clockUnknown && sessionNeedsClock && !sdkNeedsRestore) return;
  if (!clockUnknown && current?.schemaVersion === 2 && now < current.validatedAt - 120_000) {await invalidateSession(); throw {code:'SESSION_INVALID'};}
  if (!clockUnknown && (current?.schemaVersion === 2 ? now < current.sessionExpiresAt && current.accessExpiresAt > now + REFRESH_AHEAD : now - lastIdentityRefresh < 20 * 60_000)) return;
  if (sessionRefreshJob) return sessionRefreshJob;
  const token = generation;
  const promise = (async () => {
    let data = await authRequest('auth.session.refresh', () => sdkNeedsRestore && current ? auth.setSession({access_token: current.accessToken, refresh_token: current.refreshToken}) : auth.refreshSession(), 'auth.session.refresh');
    if (!displayUser(data.user)) {
      const identity = await authRequest('auth.identity.read',()=>auth.getUser(),'auth.identity.read');
      data = {...data,user:identity.user};
    }
    sdkNeedsRestore = false;
    if (token !== generation) return;
    if (String(data.user?.id) !== snapshot.user?.id) throw {code: 'AUTH_REQUIRED'};
    const warning = await rememberSession({...data.session, user: data.user}, token);
    lastIdentityRefresh = licenseNow();
    if (warning) publish({error: warning});
  })();
  sessionRefreshJob = promise;
  try {await promise;}
  catch (cause) {
    if (token === generation && ['SESSION_INVALID', 'INVALID_CREDENTIALS', 'AUTH_REQUIRED', 'AUTH_USER_BLOCKED', 'AUTH_USER_NOT_FOUND'].includes(diagnoseError(cause).resultCode)) await invalidateSession();
    else if (token === generation) nextSessionRetryAt = licenseNow() + LEASE_RETRY_DELAY;
    throw cause;
  } finally {if (sessionRefreshJob === promise) sessionRefreshJob = null;}
}
function scheduleSessionExpiry() {
  if (sessionExpiryTimer) clearTimeout(sessionExpiryTimer);
  sessionExpiryTimer = undefined;
  if (savedSession?.schemaVersion !== 2 || !snapshot.user || networkRetry) return;
  const token = generation;
  const due = Math.max(savedSession.sessionExpiresAt - LEASE_SAFETY_WINDOW, nextSessionRetryAt);
  sessionExpiryTimer = setTimeout(() => {
    if (token !== generation || !snapshot.user) return;
    if (snapshot.busy) {scheduleSessionExpiry(); return;}
    void refreshInBackground(token, 0).finally(() => {if (token === generation) scheduleSessionExpiry();});
  }, Math.max(5_000, Math.min(2_147_483_647, due - licenseNow())));
}

function publish(patch: Partial<Snapshot> = {}) {
  snapshot = {...snapshot, ...patch};
  const value = structuredClone(snapshot);
  listeners.forEach(listener => listener(value));
}
function message(cause: unknown): string {
  const error = cause as {code?: string; message?: string};
  const code = diagnoseError(cause).resultCode;
  const en = document.documentElement.lang.startsWith('en');
  const dictionary: Record<string, [string, string]> = {
    AUTH_EMAIL_INVALID: ['邮箱格式不正确。', 'Enter a valid email address.'],
    AUTH_EMAIL_EXISTS: ['该邮箱已有账户。', 'An account already uses this email.'],
    AUTH_EMAIL_UNVERIFIED: ['请先验证邮箱。', 'Verify your email first.'],
    AUTH_CODE_INVALID: ['验证码错误。', 'The verification code is incorrect.'],
    AUTH_CODE_EXPIRED: ['验证码已过期，请重新发送。', 'The verification code expired. Request a new one.'],
    AUTH_CODE_REJECTED: ['验证码错误或已过期。', 'The verification code is incorrect or expired.'],
    INVALID_CREDENTIALS: ['邮箱或密码不正确。', 'The email or password is incorrect.'],
    AUTH_USER_NOT_FOUND: ['账户不存在，请检查邮箱。', 'No account was found. Check your email.'],
    AUTH_USER_BLOCKED: ['账户当前不可用。', 'This account is currently unavailable.'],
    AUTH_PASSWORD_WEAK: ['密码强度不足。', 'The password is too weak.'],
    AUTH_PROVIDER_DISABLED: ['当前登录方式未开启。', 'This sign-in method is disabled.'],
    AUTH_CLIENT_DISABLED: ['账号服务客户端未启用。', 'The account service client is disabled.'],
    AUTH_DOMAIN_DENIED: ['账号服务未允许当前访问地址。', 'This address is not allowed by the account service.'],
    AUTH_CHANNEL_UNCONFIGURED: ['邮箱发送服务未配置。', 'Email delivery is not configured.'],
    AUTH_MAIL_DELIVERY_FAILED: ['验证码邮件发送失败。', 'The verification email could not be sent.'],
    AUTH_CAPTCHA_REQUIRED: ['需要完成安全验证后再登录。', 'Complete the security verification before signing in.'],
    AUTH_CAPTCHA_INVALID: ['安全验证未通过。', 'Security verification failed.'],
    AUTH_MFA_REQUIRED: ['此账户需要二次验证。', 'This account requires additional verification.'],
    NETWORK_OFFLINE: ['当前网络已断开。', 'You are offline.'],
    NETWORK_TIMEOUT: ['请求超时，请重试。', 'The request timed out. Please retry.'],
    NETWORK_UNREACHABLE: ['无法连接账号服务。', 'The account service could not be reached.'],
    NETWORK_RETRIES_EXHAUSTED: ['网络重试三次仍失败，请手动登录。', 'Three network retries failed. Please sign in again.'],
    REQUEST_ABORTED: ['请求已取消。', 'The request was cancelled.'],
    AUTH_REQUIRED: ['请重新登录。', 'Please sign in again.'],
    SESSION_STORAGE_UNAVAILABLE: ['无法保存或读取登录信息，请检查运行时文件夹的读写权限。', 'Cannot save or read sign-in information. Check runtime folder permissions.'],
    SESSION_STORAGE_INVALID: ['保存的登录信息不可用，请重新登录。', 'Saved sign-in information is invalid. Please sign in again.'],
    LICENSE_CLOCK_UNTRUSTED: ['需要联网校验授权。', 'Connect to verify your license.'],
    AUTH_CONTEXT_UNSUPPORTED: ['登录身份尚未通过服务端验证。', 'The server could not verify this sign-in.'],
    ACTIVATION_CODE_UNAVAILABLE: ['激活码无效或已被使用。', 'This activation code is invalid or already used.'],
    INVALID_ACTIVATION_CODE: ['激活码格式不正确。', 'The activation code format is invalid.'],
    DEVICE_LIMIT_REACHED: ['设备数量已达上限，请先移除设备。', 'Device limit reached. Remove a device first.'],
    DEVICE_BINDING_CONFIRMATION_REQUIRED: ['请先确认绑定当前设备。', 'Confirm linking this device first.'],
    DEVICE_REVOKED: ['当前设备授权已移除，请重新登录。', 'This device was removed. Sign in again.'],
    LICENSE_ALREADY_ACTIVE: ['账户已激活，请检查授权。', 'Your account is already activated. Check the license.'],
    LICENSE_REQUIRED: ['请先激活授权。', 'Activate a license first.'],
    LICENSE_EXPIRED: ['授权已到期。', 'The license has expired.'],
    LICENSE_REVOKED: ['授权已撤销。', 'The license has been revoked.'],
    CERTIFICATE_INVALID: ['授权签名验证失败。', 'License verification failed.'],
    RATE_LIMITED: ['操作过于频繁，请稍后重试。', 'Too many requests. Try again later.'],
    VERIFICATION_REQUIRED: ['请先发送邮箱验证码。', 'Send an email code first.'],
    EMAIL_ALREADY_SIGNED_IN: ['该邮箱已有账户，请使用登录。', 'This email already has an account. Sign in instead.'],
    SERVICE_UNCONFIGURED: ['授权服务尚未配置完成。', 'The license service is not configured.'],
    PASSWORD_INVALID: ['密码需为 8–128 位，包含英文字母和数字。', 'Use 8–128 characters, including a letter and a number.'],
    RESEND_TOO_SOON: ['请稍后重新发送验证码。', 'Wait before requesting another code.'],
  };
  if (dictionary[code]) return dictionary[code][en ? 1 : 0];
  if (/password|credential|invalid_login|InvalidParameter|用户不存在|密码错误/i.test(code)) return en ? 'Check your email and password.' : '请检查邮箱和密码。';
  if (/code|otp|nonce|verification|验证码/i.test(code)) return en ? 'The code is invalid or expired.' : '验证码错误或已过期。';
  if (/domain|origin|permission|Forbidden|安全域名/i.test(code)) return en ? 'This address is not allowed by the account service.' : '账号服务未允许当前访问地址。';
  return en ? 'The service is unavailable. Please try again.' : '服务暂时无法连接，请重试。';
}
function checked<T extends {error?: unknown; data?: unknown}>(result: T): NonNullable<T['data']> {
  if (result.error) throw result.error;
  return result.data as NonNullable<T['data']>;
}
async function operation<T>(name: DiagnosticOperation, action: () => Promise<T>) {
  const span = diagnosticSpan(name, 'operation', undefined, {stage: 'client.operation'});
  if (snapshot.busy) {span.fail({code: 'BUSY'}); throw new Error('BUSY');}
  publish({busy: true, error: null});
  try {
    const activeRefresh = [licenseJob?.promise, sessionRefreshJob, networkRetryJob].filter(Boolean);
    if (activeRefresh.length) {
      await Promise.allSettled(activeRefresh);
      publish({error: null});
    }
    activeOperation = {traceId: span.traceId, name};
    const result = await action();
    span.succeed();
    return result;
  }
  catch (cause) {span.fail(cause); const error = new Error(message(cause)); publish({error: error.message}); throw error;}
  finally {activeOperation = undefined; publish({busy: false}); scheduleSessionExpiry();}
}
async function authRequest(stage: string, action: () => Promise<any>, name?: DiagnosticOperation): Promise<any> {
  const token = generation;
  const span = diagnosticSpan(name ?? activeOperation?.name ?? 'auth.session.refresh', 'operation', undefined, {stage, parentTraceId: activeOperation?.traceId});
  try {const result = checked(await action()); span.succeed(); return result;}
  catch (cause) {span.fail(cause); await queueNetworkRetry(cause, token); throw cause;}
}
function passwordPolicy(password: string) {
  if (!passwordValid(password)) throw {code: 'PASSWORD_INVALID'};
}
type CodePurpose = 'registration' | 'reset' | 'change';
const codeCooldowns = new Map<string, number>();
const codeKey = (purpose: CodePurpose, email: string) => `${purpose}:${email.trim().toLowerCase()}`;
function codeRetryAt(purpose: CodePurpose, email: string) {
  return codeCooldowns.get(codeKey(purpose, email)) ?? 0;
}
function setCodeCooldown(purpose: CodePurpose, email: string, seconds: number) {
  const key = codeKey(purpose, email);
  codeCooldowns.delete(key);
  codeCooldowns.set(key, Date.now() + seconds * 1000);
  while (codeCooldowns.size > 100) codeCooldowns.delete(codeCooldowns.keys().next().value!);
}
async function sendCodeRequest(purpose: CodePurpose, email: string, stage: string, action: () => Promise<any>) {
  const remaining = Math.ceil((codeRetryAt(purpose, email) - Date.now()) / 1000);
  if (remaining > 0) throw {code: 'RESEND_TOO_SOON', retryAfter: remaining};
  try {return await authRequest(stage, action);}
  catch (cause) {
    const detail = diagnoseError(cause, {stage});
    if (detail.resultCode === 'RATE_LIMITED') setCodeCooldown(purpose, email, Math.max(1, detail.retryAfterSeconds ?? 60));
    throw cause;
  }
}
function clearAuthorization() {
  certificate = null;
  if (renewal) clearTimeout(renewal);
  renewal = undefined;
  pending.clear();
  devicesJob = null; devicesCheckedAt = 0; deviceListCache = null;
  publish({license: null, devices: [], devicesState: 'idle', devicesError: null, devicesMaxDevices: null, bindingPrompt:null});
}
async function loadIdentity() {
  const {user} = await authRequest('auth.identity.read', () => auth.getUser(), 'auth.identity.read');
  if (!user || user.is_anonymous) throw {code: 'AUTH_REQUIRED'};
  publish({user: {id: String(user.id), email: String(user.email ?? ''), nickname: String(user.user_metadata?.name ?? user.user_metadata?.nickName ?? '')}});
}
async function cloud(action: 'status' | 'activate' | 'bind' | 'devices' | 'revoke' | 'renew', fields: Record<string, unknown> = {}, write = false, stableRequestId?: string): Promise<any> {
  await ensureFreshSession();
  const token = generation;
  const userId = snapshot.user!.id;
  const key = JSON.stringify([snapshot.user!.id, action, fields]);
  let requestId = stableRequestId ?? pending.get(key);
  if (write && !requestId) {requestId = crypto.randomUUID(); pending.set(key, requestId);}
  const clientTraceId = crypto.randomUUID();
  const span = diagnosticSpan(`license.${action}`, 'cloud', clientTraceId, {stage: 'cloud.invoke', parentTraceId: activeOperation?.traceId});
  try {
    const before = secureTiming ? await licenseClock.sample() : null;
    const response = await app.callFunction({name: 'license-api', data: {action, ...fields, ...(write ? {requestId} : {}), clientTraceId}});
    const result = typeof response.result === 'string' ? JSON.parse(response.result) : response.result as any;
    if (!result?.ok) throw {code: result?.error?.code ?? 'SERVICE_UNAVAILABLE', serverTraceId: result?.traceId, retryable: result?.error?.retryable};
    if (token !== generation || snapshot.user?.id !== userId) return result.data;
    if (before) {
      const serverTime = await verifyServerTimeProof(result.timeProof, trust, {userId, nonce: clientTraceId});
      if (token !== generation || snapshot.user?.id !== userId) throw {code: 'AUTH_REQUIRED'};
      await licenseClock.observe(serverTime, before);
      if (token !== generation || snapshot.user?.id !== userId) throw {code: 'AUTH_REQUIRED'};
      const now = licenseNow();
      if (savedSession?.schemaVersion === 1) savedSession = {...savedSession,schemaVersion:2,accessExpiresAt:now,validatedAt:now,sessionExpiresAt:now+SESSION_MAX_AGE,user:snapshot.user!,scope:'',licenseCache};
      if (savedSession?.schemaVersion === 2) {
        if (sessionNeedsClock) savedSession = {...savedSession, validatedAt: now, sessionExpiresAt: now + SESSION_MAX_AGE};
        else if (now >= savedSession.sessionExpiresAt) {
          publish({license:{...snapshot.license,status:'lease_expired',active:false}});
          nextSessionRetryAt=now+LEASE_RETRY_DELAY; scheduleSessionExpiry();
          throw {code:'NETWORK_TIMEOUT',retryable:true};
        }
        else savedSession = {...savedSession, validatedAt: now};
      }
      sessionNeedsClock = false;
      scheduleClockGuard(); scheduleSessionExpiry();
    }
    if (write && action !== 'renew') pending.delete(key);
    span.succeed({licenseStatus: result.data?.status, serverTraceId: result.traceId});
    return result.data;
  } catch (cause) {
    span.fail(cause);
    if (token === generation && ['SESSION_INVALID', 'AUTH_REQUIRED', 'INVALID_CREDENTIALS', 'AUTH_USER_BLOCKED', 'AUTH_USER_NOT_FOUND'].includes(diagnoseError(cause).resultCode)) await invalidateSession();
    else await queueNetworkRetry(cause, token, action === 'devices');
    throw cause;
  }
}
const deviceFields = () => ({deviceId: snapshot.deviceId, deviceName: window.vibeNative?.deviceName || (window.vibeNative ? 'Mac' : 'Web browser'), appVersion: '0.1.0'});
const serverDeviceLimit = (value: unknown): number | null => Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 100 ? Number(value) : null;
const cacheText = (value: unknown, max: number, empty = true): value is string => typeof value === 'string' && (empty || value.length > 0) && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
function validDeviceListCache(value: any): value is DeviceListCache {
  return value && Object.keys(value).sort().join(',') === 'checkedAt,devices,licenseId,maxDevices,userId' &&
    Number.isSafeInteger(value.checkedAt) && value.checkedAt > 0 && cacheText(value.userId, 256, false) && cacheText(value.licenseId, 256) &&
    Number.isInteger(value.maxDevices) && value.maxDevices >= 0 && value.maxDevices <= 100 && Array.isArray(value.devices) && value.devices.length <= 100 &&
    new Set(value.devices.map((device: any) => device?.deviceId)).size === value.devices.length && value.devices.every((device: any) => device &&
      Object.keys(device).sort().join(',') === 'bindingId,deviceId,deviceName,lastSeenAt' && cacheText(device.deviceId, 128, false) &&
      cacheText(device.bindingId, 80) && cacheText(device.deviceName, 80) && cacheText(device.lastSeenAt, 64));
}
function restoreDeviceList(value: LicenseCache) {
  const list = value.deviceList;
  if (!list || list.userId !== snapshot.user?.id || list.licenseId !== value.licenseId || list.checkedAt > licenseNow() + 120_000) return;
  deviceListCache = list; devicesCheckedAt = list.checkedAt;
  publish({devices: list.devices.map(device => ({...device, isCurrent: device.deviceId === snapshot.deviceId})), devicesState: 'ready', devicesError: null, devicesMaxDevices: serverDeviceLimit(list.maxDevices)});
}
async function loadDevices(force = false) {
  if (!snapshot.user) throw new Error(message({code: 'AUTH_REQUIRED'}));
  const token = generation, userId = snapshot.user.id;
  if (devicesJob?.generation === token) return devicesJob.promise;
  const age = licenseNow() - devicesCheckedAt;
  if (!force && snapshot.devicesState === 'ready' && age >= 0 && age < DEVICE_LIST_MAX_AGE) return;
  publish({devicesState: 'loading', devicesError: null});
  const promise = (async () => {
    try {
      const result = await cloud('devices', {currentDeviceId: snapshot.deviceId});
      if (token !== generation || snapshot.user?.id !== userId) return;
      if (!Array.isArray(result?.devices) || result.devices.length > 100) throw {code: 'SERVICE_UNAVAILABLE'};
      devicesCheckedAt = licenseNow();
      const maximum = serverDeviceLimit(result.maxDevices) ?? serverDeviceLimit(result.entitlement?.maxDevices) ?? serverDeviceLimit(snapshot.license?.maxDevices);
      const devices = result.devices.map((value: any) => ({deviceId: value?.deviceId, bindingId: value?.bindingId ?? '', deviceName: value?.deviceName ?? '', lastSeenAt: value?.lastSeenAt ?? ''}));
      const cache = {checkedAt: devicesCheckedAt, userId, licenseId: licenseCache?.licenseId ?? snapshot.license?.licenseId ?? '', maxDevices: maximum ?? 0, devices};
      if (!validDeviceListCache(cache)) throw {code: 'SERVICE_UNAVAILABLE'};
      deviceListCache = cache;
      publish({devices: devices.map((device: CachedDevice) => ({...device, isCurrent: device.deviceId === snapshot.deviceId})), devicesState: 'ready', devicesError: null, devicesMaxDevices: maximum});
      if (licenseCache) {
        licenseCache = {...licenseCache, maxDevices: maximum ?? licenseCache.maxDevices, deviceList: cache};
        const warning = await persistCurrentSession(token);
        if (warning && token === generation) throw {code: 'SESSION_STORAGE_UNAVAILABLE'};
      }
    } catch (cause) {
      if (token === generation && snapshot.user?.id === userId) publish({devicesState: 'error', devicesError: message(cause)});
      throw cause;
    }
  })();
  devicesJob = {generation: token, promise};
  try {await promise;} finally {if (devicesJob?.promise === promise) devicesJob = null;}
}
const leaseTokenValid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function validRenewal(value: any): value is LeaseRenewal {
  return value && Object.keys(value).length === 6 && /^[0-9a-f-]{36}$/i.test(value.requestId) && /^renew_[a-f0-9]{32}$/.test(value.renewalId) && leaseTokenValid(value.nextLeaseToken) &&
    Number.isSafeInteger(value.startedAt) && value.startedAt > 0 && Number.isInteger(value.retryCount) && value.retryCount >= 0 && value.retryCount <= 5 && Number.isSafeInteger(value.nextRetryAt) && value.nextRetryAt >= 0;
}
function cacheShape(value: any): value is LicenseCache {
  if (!value || ![6, 8, 9].includes(Object.keys(value).length) || !Number.isSafeInteger(value.checkedAt) || value.checkedAt <= 0 || value.checkedAt > licenseNow() + 120_000) return false;
  if (Object.keys(value).length >= 8 && (!(value.leaseToken === '' || leaseTokenValid(value.leaseToken)) || !(value.renewal === null || validRenewal(value.renewal)))) return false;
  if (Object.keys(value).length === 9 && !(value.deviceList === null || validDeviceListCache(value.deviceList))) return false;
  return true;
}
async function saveLicenseCache(token = generation) {
  if (token !== generation) return;
  const claims = certificate?.claims;
  if (licenseCache) licenseCache = {...licenseCache, leaseToken, renewal: leaseRenewal, deviceList: deviceListCache};
  else licenseCache = {checkedAt: licenseNow(), status: snapshot.license?.status ?? 'invalid', certificate: certificate?.certificate ?? null, bindingId: claims?.bindingId ?? '', licenseId: claims?.licenseId ?? '', maxDevices: snapshot.license?.maxDevices ?? 0, leaseToken, renewal: leaseRenewal, deviceList: deviceListCache};
  const warning = await persistCurrentSession(token);
  if (warning) throw {code: 'SESSION_STORAGE_UNAVAILABLE'};
}
function scheduleLicenseCheck(due: number) {
  if (renewal) clearTimeout(renewal);
  nextLicenseCheckAt = due;
  const token = generation;
  if (networkRetry) return;
  renewal = setTimeout(() => {
    if (token === generation && snapshot.user) void refreshInBackground(token, 0);
  }, Math.max(1_000, Math.min(2_147_483_647, due - licenseNow())));
}
async function acceptCertificate(result: any, checkedAt = licenseNow()) {
  const cert = result?.certificate;
  if (!snapshot.user) throw {code: 'AUTH_REQUIRED'};
  if (secureTiming && !licenseClock.trusted) throw {code: 'LICENSE_CLOCK_UNTRUSTED'};
  const currentGeneration = generation;
  const userId = snapshot.user.id;
  let claims;
  const span = diagnosticSpan('license.certificate.verify', 'operation', undefined, {stage: 'license.verify', parentTraceId: activeOperation?.traceId});
  try {
    claims = await verifyLicenseCertificate(cert, trust, {userId, deviceId: snapshot.deviceId, bindingId: result.device?.bindingId, licenseId: result.entitlement?.licenseId, now: licenseNow()});
    if (result.leaseToken !== undefined && !leaseTokenValid(result.leaseToken)) throw {code: 'CERTIFICATE_INVALID'};
    span.succeed({licenseStatus: 'valid'});
  } catch (cause) {
    span.fail({code: 'CERTIFICATE_INVALID'}, {licenseStatus: 'invalid'});
    if (currentGeneration === generation) publish({license: {...snapshot.license, status: 'invalid', active: false}});
    throw cause;
  }
  if (currentGeneration !== generation || snapshot.user?.id !== userId) return;
  certificate = {claims, certificate: cert};
  leaseToken = result.leaseToken ?? '';
  leaseRenewal = null;
  const maximum = serverDeviceLimit(result.entitlement?.maxDevices) ?? serverDeviceLimit(result.maxDevices) ?? snapshot.devicesMaxDevices ?? 0;
  licenseCache = {checkedAt, status: 'valid', certificate: cert, bindingId: claims.bindingId, licenseId: claims.licenseId, maxDevices: maximum, leaseToken, renewal: null, deviceList: deviceListCache};
  publish({license: {...claims, maxDevices: maximum, status: 'valid', entitlementActive: true, active: true}, error: null, bindingPrompt: null});
  const entitlementEnd = Date.parse(claims.expiresAt);
  const leaseEnd = Math.min(Date.parse(claims.leaseExpiresAt), Date.parse(claims.offlineUntil));
  const safety = Math.min(LEASE_SAFETY_WINDOW, Math.floor((leaseEnd - Date.parse(claims.issuedAt)) / 2));
  scheduleLicenseCheck(Math.min(checkedAt + LEASE_RENEWAL_INTERVAL, leaseEnd < entitlementEnd ? leaseEnd - safety : entitlementEnd));
  scheduleClockGuard();
}
async function deriveNextLeaseToken(token: string, renewalId: string) {
  const bytes = new TextEncoder().encode('vibe-improve:lease-renewal:v2:' + token + ':' + renewalId);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, value => value.toString(16).padStart(2, '0')).join('');
}
async function renewBoundDevice(bindingId: string) {
  if (leaseToken && !leaseRenewal) {
    const renewalId = 'renew_' + crypto.randomUUID().replace(/-/g, '').toLowerCase();
    leaseRenewal = {requestId: crypto.randomUUID(), renewalId, nextLeaseToken: await deriveNextLeaseToken(leaseToken, renewalId), startedAt: licenseNow(), retryCount: 0, nextRetryAt: 0};
    await saveLicenseCache();
  }
  const attempt = leaseRenewal;
  const result = await cloud('renew', {deviceId: snapshot.deviceId, bindingId, ...(attempt ? {leaseToken, renewalId: attempt.renewalId, nextLeaseToken: attempt.nextLeaseToken} : {})}, true, attempt?.requestId);
  if (attempt && result.leaseToken !== attempt.nextLeaseToken) throw {code: 'CERTIFICATE_INVALID'};
  await acceptCertificate(result);
  for (const [key, requestId] of pending) if (requestId === attempt?.requestId) pending.delete(key);
  await saveLicenseCache();
}
async function claimCurrentDevice() {
  const result = await cloud('bind', deviceFields(), true);
  await acceptCertificate(result);
  await saveLicenseCache();
}
function hasValidLocalLease() {
  if (secureTiming && !licenseClock.trusted) return false;
  const now=licenseNow();
  return Boolean(certificate?.claims && (savedSession?.schemaVersion !== 2 || now < savedSession.sessionExpiresAt) &&
    now < Math.min(Date.parse(certificate.claims.expiresAt),Date.parse(certificate.claims.leaseExpiresAt),Date.parse(certificate.claims.offlineUntil)));
}
async function licenseFailure(cause: unknown, token: number) {
  if (token !== generation || !snapshot.user) return;
  const detail = diagnoseError(cause);
  if (detail.resultCode === 'DEVICE_LIMIT_REACHED') {
    certificate = null; leaseToken = ''; leaseRenewal = null;
    licenseCache = {checkedAt: licenseNow(), status: 'device_limit', certificate: null, bindingId: '', licenseId: snapshot.license?.licenseId ?? '', maxDevices: snapshot.devicesMaxDevices ?? snapshot.license?.maxDevices ?? 0, leaseToken: '', renewal: null, deviceList: deviceListCache};
    publish({license: {...snapshot.license, status: 'device_limit', entitlementActive: true, active: false}, error: message(cause)});
    await saveLicenseCache(token); scheduleLicenseCheck(licenseNow() + LICENSE_STATUS_MAX_AGE);
    return;
  }
  if (['SESSION_STORAGE_INVALID', 'SESSION_STORAGE_UNAVAILABLE'].includes(detail.resultCode)) {
    await invalidateSession(); publish({error: message(cause)}); return;
  }
  const terminal = ['DEVICE_REVOKED', 'LICENSE_REVOKED', 'LICENSE_EXPIRED', 'LICENSE_CHANGED', 'CERTIFICATE_INVALID'].includes(detail.resultCode);
  const retryable = detail.retryable || ['NETWORK_OFFLINE', 'NETWORK_TIMEOUT', 'NETWORK_UNREACHABLE', 'SERVICE_UNAVAILABLE', 'RATE_LIMITED', 'DATABASE_CONFLICT'].includes(detail.resultCode);
  if (terminal || (leaseRenewal && !retryable)) {
    const status = detail.resultCode === 'LICENSE_EXPIRED' ? 'expired' : detail.resultCode === 'DEVICE_REVOKED' ? 'device_revoked' : detail.resultCode === 'LICENSE_REVOKED' ? 'revoked' : 'invalid';
    resetNetworkRetry(); nextSessionRetryAt = 0;
    certificate = null; leaseToken = ''; leaseRenewal = null;
    licenseCache = {checkedAt: licenseNow(), status, certificate: null, bindingId: '', licenseId: licenseCache?.licenseId ?? snapshot.license?.licenseId ?? '', maxDevices: snapshot.devicesMaxDevices ?? snapshot.license?.maxDevices ?? 0, leaseToken: '', renewal: null, deviceList: deviceListCache};
    publish({license: {...snapshot.license, status, entitlementActive: status === 'device_revoked', active: false}, bindingPrompt: null, error: message(cause)});
    await saveLicenseCache(token);
    scheduleLicenseCheck(licenseNow() + LICENSE_STATUS_MAX_AGE);
    return;
  }
  if (leaseRenewal && retryable) {
    const count = Math.min(MAX_RETRY_COUNT, leaseRenewal.retryCount + 1);
    leaseRenewal = {...leaseRenewal, retryCount: count, nextRetryAt: networkRetry?.nextRetryAt ?? licenseNow() + retryDelay(count)};
    nextSessionRetryAt = leaseRenewal.nextRetryAt;
    try {await saveLicenseCache(token);} catch {await invalidateSession(); return;}
    const stillValid = hasValidLocalLease();
    publish({license: {...snapshot.license, status: stillValid ? 'renewal_retry' : 'lease_expired', active: Boolean(stillValid)}, error: message(cause)});
    if (!networkRetry) await queueNetworkRetry(cause, token);
  }
}
async function refreshInBackground(token: number, _attempt: number) {
  if (token !== generation || !snapshot.user || networkRetry) return;
  if (snapshot.busy) {renewal = setTimeout(() => void refreshInBackground(token, 0), 5_000); return;}
  const span = diagnosticSpan('license.refresh', 'background');
  try {await refreshLicenseInternal(false, false, true); span.succeed({licenseStatus: snapshot.license?.status});}
  catch (cause) {
    span.fail(cause, {licenseStatus: snapshot.license?.status});
    if (token !== generation) return;
    const detail = diagnoseError(cause);
    if (!leaseRenewal && detail.retryable) {
      const stillValid = hasValidLocalLease();
      if (['device_limit', 'device_revoked', 'expired', 'revoked', 'unlicensed'].includes(snapshot.license?.status)) publish({error: message(cause)});
      else publish({license: {...snapshot.license, status: stillValid ? 'offline_valid' : 'network_error', active: Boolean(stillValid)}, error: message(cause)});
      await queueNetworkRetry(cause, token);
    }
  }
}
async function readLicenseFromCloud(claim = false, requireDeviceList = true, skipDevices = false) {
  const token = generation;
  const readDevices = () => skipDevices ? Promise.resolve() : loadDevices(true).catch(cause => {if (requireDeviceList || !snapshot.user) throw cause;});
  if (!claim && licenseCache?.bindingId && (certificate || leaseToken || (secureTiming && !licenseClock.trusted))) {
    if (!networkRetryJob && leaseRenewal?.nextRetryAt && (!secureTiming || licenseClock.trusted) && licenseNow() < leaseRenewal.nextRetryAt) {scheduleLicenseCheck(leaseRenewal.nextRetryAt); return;}
    await renewBoundDevice(licenseCache.bindingId);
    await readDevices();
    return;
  }
  const autoClaimSuppressed = !claim && licenseCache?.status === 'device_revoked';
  const status = await cloud('status', {deviceId: snapshot.deviceId});
  if (token !== generation) return;
  certificate = null;
  if (!autoClaimSuppressed) licenseCache = null;
  if (renewal) clearTimeout(renewal);
  renewal = undefined;
  publish({license: {...status.entitlement, status: autoClaimSuppressed && status.status === 'valid' ? 'device_revoked' : status.status, entitlementActive: status.status === 'valid', active: false}});
  const cacheWarning = await persistCurrentSession(token);
  if (cacheWarning) publish({error: cacheWarning});
  if (status.status === 'valid' && !autoClaimSuppressed && status.device?.deviceId === snapshot.deviceId) {
    try {await claimCurrentDevice();}
    catch (cause) {await loadDevices(true).catch(() => {}); throw cause;}
  } else {
    leaseToken = ''; leaseRenewal = null;
    const localStatus = status.status === 'valid' ? autoClaimSuppressed ? 'device_revoked' : 'device_unbound' : status.status;
    licenseCache = {checkedAt: licenseNow(), status: localStatus, certificate: null, bindingId: '', licenseId: status.entitlement?.licenseId ?? '', maxDevices: status.entitlement?.maxDevices ?? 0, leaseToken: '', renewal: null};
    publish({license: {...status.entitlement, status: localStatus, entitlementActive: status.status === 'valid', active: false}});
    scheduleLicenseCheck(licenseNow() + LICENSE_STATUS_MAX_AGE);
  }
  if (token === generation) await saveLicenseCache(token);
  if (token !== generation) return;
  if (status.status === 'valid' && !status.device && !autoClaimSuppressed) {
    await loadDevices(true);
    if (token !== generation) return;
    const maximum = snapshot.devicesMaxDevices;
    if (maximum === null) throw {code:'SERVICE_UNAVAILABLE'};
    const full = snapshot.devices.length >= maximum;
    licenseCache = {...licenseCache!,status:full ? 'device_limit':'device_unbound',maxDevices:maximum};
    publish({license:{...snapshot.license,status:full ? 'device_limit':'device_unbound'},bindingPrompt:!full && claim ? {used:snapshot.devices.length,maximum}:null});
    await saveLicenseCache(token);
  } else await readDevices();
}
async function refreshLicenseInternal(claim = false, requireDeviceList = true, skipDevices = false) {
  const token = generation;
  if (licenseJob?.generation === token) return licenseJob.promise;
  const promise = readLicenseFromCloud(claim, requireDeviceList, skipDevices).catch(async cause => {await licenseFailure(cause, token); throw cause;});
  licenseJob = {generation: token, promise};
  try {await promise;}
  finally {if (licenseJob?.promise === promise) licenseJob = null;}
}
async function beginLicenseMutation() {
  generation++;
  scheduleNetworkRetry();
  devicesJob = null; devicesCheckedAt = 0;
  if (snapshot.devicesState === 'loading') publish({devicesState: 'idle', devicesError: null});
  certificate = null; licenseCache = null; nextLicenseCheckAt = 0; leaseToken = ''; leaseRenewal = null;
  publish({license: {...snapshot.license, status: 'checking', active: false},bindingPrompt:null});
  if (renewal) clearTimeout(renewal);
  renewal = undefined;
  const warning = await persistCurrentSession();
  if (warning) throw {code: 'SESSION_STORAGE_UNAVAILABLE'};
}
async function afterLogin(session?: any, continuing = false) {
  generation++;
  if (!continuing) resetNetworkRetry();
  publish({reauthRequired:false});
  sessionWritesEnabled = false;
  clearAuthorization();
  licenseCache = null; nextLicenseCheckAt = 0; leaseToken = ''; leaseRenewal = null;
  if (!continuing) {savedSession = null; sessionNeedsClock = secureTiming && !licenseClock.trusted;}
  else if (savedSession?.schemaVersion === 1) sessionNeedsClock = secureTiming && !licenseClock.trusted;
  const restoredCache = continuing && savedSession?.schemaVersion === 2 ? savedSession.licenseCache : null;
  const storageWarning = await rememberSession(session);
  const sessionUser = displayUser(session?.user);
  if (sessionUser) publish({user:sessionUser});
  try {await loadIdentity();}
  catch (cause) {
    if (!diagnoseError(cause).retryable) throw cause;
    sessionWritesEnabled = true;
    publish({license:{status:'network_error',active:false},error:message(cause)});
    scheduleNetworkRetry(); return;
  }
  sessionWritesEnabled = true;
  lastIdentityRefresh = licenseNow();
  scheduleSessionExpiry();
  try {
    if (restoredCache && await restoreLicenseCache(restoredCache)) await saveLicenseCache();
    else await refreshLicenseInternal(!restoredCache, false);
  }
  catch (cause) {
    const code = diagnoseError(cause).resultCode;
    if (!snapshot.user) throw cause;
    if (['SESSION_INVALID', 'AUTH_REQUIRED', 'INVALID_CREDENTIALS', 'AUTH_USER_NOT_FOUND', 'AUTH_USER_BLOCKED', 'SESSION_STORAGE_INVALID', 'SESSION_STORAGE_UNAVAILABLE'].includes(code)) {await invalidateSession(); throw cause;}
    publish({error: message(cause)});
  }
  if (storageWarning) publish({error: [snapshot.error, storageWarning].filter(Boolean).join('\n')});
}
async function signOut() {
  generation++;
  sessionWritesEnabled = false;
  clearAuthorization();
  registration = null; resetChallenge = null; changeChallenge = null;
  await forgetSession();
  try {await authRequest('auth.signout', () => auth.signOut(), 'auth.logout');}
  finally {memory.clear(); publish({user: null});}
}
function scheduleClockGuard() {
  if (clockTimer) clearTimeout(clockTimer);
  clockTimer = undefined;
  if (!secureTiming || !snapshot.user) return;
  const deadline = Math.min(savedSession?.schemaVersion === 2 && savedSession.sessionExpiresAt > licenseNow() ? savedSession.sessionExpiresAt : Infinity,
    certificate && snapshot.license?.active ? Math.min(Date.parse(certificate.claims.expiresAt), Date.parse(certificate.claims.leaseExpiresAt), Date.parse(certificate.claims.offlineUntil)) : Infinity);
  const delay = licenseClock.trusted ? Math.max(1, Math.min(30_000, deadline - licenseNow())) : 30_000;
  clockTimer = setTimeout(() => {void checkLicenseTime().then(refreshIfDue);}, delay);
}
async function checkLicenseTime() {
  if (!secureTiming || !snapshot.user) return;
  if (clockJob) return clockJob;
  const token = generation;
  const job = (async () => {
    try {
      await licenseClock.sample();
      if (token !== generation || !snapshot.user) return;
      if (!licenseClock.trusted) throw {code:'LICENSE_CLOCK_UNTRUSTED'};
      const now = licenseNow();
      if (savedSession?.schemaVersion === 2 && now >= savedSession.sessionExpiresAt) {publish({license:{...snapshot.license,status:'lease_expired',active:false}}); return;}
      if (certificate && now >= Math.min(Date.parse(certificate.claims.expiresAt), Date.parse(certificate.claims.leaseExpiresAt), Date.parse(certificate.claims.offlineUntil))) {
        publish({license:{...snapshot.license,status:'lease_expired',active:false}});
      }
    } catch (cause) {
      if (token === generation) publish({license:{...snapshot.license,status:'network_error',active:false},error:message(cause)});
    }
  })();
  clockJob = job;
  try {await job;} finally {if (clockJob === job) clockJob = null; scheduleClockGuard();}
}
const service = {
  getSnapshot: async () => structuredClone(snapshot),
  whenReady: () => startup,
  loadDevices,
  requireFeature: async (feature: string) => {
    await checkLicenseTime();
    if (!snapshot.user || !snapshot.license?.active || (secureTiming && !licenseClock.trusted) || !certificate?.claims.features.includes(feature)) throw {code:'LICENSE_REQUIRED'};
  },
  getCodeRetryAt: codeRetryAt,
  subscribe(listener: (value: Snapshot) => void) {listeners.add(listener); return () => {listeners.delete(listener);};},
  login: (email: string, password: string) => operation('auth.login', async () => {const data = await authRequest('auth.password.signin', () => auth.signInWithPassword({email, password})); await afterLogin(data.session);}),
  sendRegistration: (email: string, password: string, nickname: string) => operation('auth.registration.send', async () => {
    passwordPolicy(password);
    const data = await sendCodeRequest('registration', email, 'auth.registration.send', () => auth.signUp({email, password, name: nickname}));
    if (typeof data.verifyOtp !== 'function') {await signOut(); throw {code: 'EMAIL_ALREADY_SIGNED_IN'};}
    registration = {email, verify: token => data.verifyOtp!({token})}; setCodeCooldown('registration', email, 60);
  }),
  register: (email: string, _password: string, _nickname: string, code?: string) => operation('auth.registration.verify', async () => {
    if (!registration || registration.email !== email || !code) throw {code: 'VERIFICATION_REQUIRED'};
    const data = await authRequest('auth.registration.verify', () => registration!.verify(code)); registration = null; await afterLogin(data.session);
  }),
  sendReset: (email: string) => operation('auth.password.reset.send', async () => {
    const data = await sendCodeRequest('reset', email, 'auth.reset.send', () => auth.resetPasswordForEmail(email));
    if (typeof data.updateUser !== 'function') throw {code: 'VERIFICATION_REQUIRED'};
    resetChallenge = (nonce, password) => data.updateUser!({nonce, password}); setCodeCooldown('reset', email, 60);
  }),
  resetPassword: (code: string, password: string) => operation('auth.password.reset', async () => {
    passwordPolicy(password); if (!resetChallenge) throw {code: 'VERIFICATION_REQUIRED'};
    await authRequest('auth.reset.verify', () => resetChallenge!(code, password)); resetChallenge = null; await signOut();
  }),
  sendChangePassword: () => operation('auth.password.change.send', async () => {
    await ensureFreshSession();
    if (!snapshot.user) throw {code: 'AUTH_REQUIRED'};
    const data = await sendCodeRequest('change', snapshot.user.email, 'auth.change.send', () => auth.reauthenticate()); if (typeof data.updateUser !== 'function') throw {code: 'VERIFICATION_REQUIRED'};
    changeChallenge = (nonce, password) => data.updateUser!({nonce, password}); setCodeCooldown('change', snapshot.user.email, 60);
  }),
  changePassword: (oldPassword: string, newPassword: string, code: string) => operation('auth.password.change', async () => {
    passwordPolicy(newPassword); if (!snapshot.user || !changeChallenge) throw {code: 'VERIFICATION_REQUIRED'};
    const identity = snapshot.user.id;
    const verified = await authRequest('auth.password.signin', () => auth.signInWithPassword({email: snapshot.user!.email, password: oldPassword}));
    if (String(verified.user?.id) !== identity) {await signOut(); throw {code: 'AUTH_REQUIRED'};}
    await authRequest('auth.change.verify', () => changeChallenge!(code, newPassword)); changeChallenge = null; await signOut();
  }),
  logout: () => operation('auth.logout', signOut),
  activate: (activationCode: string) => operation('license.activate', async () => {
    await beginLicenseMutation();
    const token = generation;
    try {
      const result = await cloud('activate', {activationCode: activationCode.toUpperCase(), ...deviceFields()}, true);
      await acceptCertificate(result); await saveLicenseCache();
      await loadDevices(true).catch(cause => {if (!snapshot.user) throw cause;});
    } catch (cause) {await licenseFailure(cause, token); throw cause;}
  }),
  bindDevice: () => operation('license.bind', async () => {
    if (!snapshot.bindingPrompt || !snapshot.user) throw {code:'DEVICE_BINDING_CONFIRMATION_REQUIRED'};
    await beginLicenseMutation(); const token = generation;
    try {await claimCurrentDevice(); await loadDevices(true).catch(cause => {if (!snapshot.user) throw cause;});}
    catch (cause) {await licenseFailure(cause, token); throw cause;}
  }),
  requestDeviceBinding: () => operation('license.refresh', () => refreshLicenseInternal(true)),
  dismissDeviceBinding: () => publish({bindingPrompt:null}),
  revokeDevice: (deviceId: string) => operation('license.revoke', async () => {
    const previous = {certificate, licenseCache, leaseToken, leaseRenewal};
    const hadLease = Boolean(certificate);
    await beginLicenseMutation();
    await cloud('revoke', {deviceId}, true);
    if (deviceId === snapshot.deviceId) {
      certificate = null; leaseToken = ''; leaseRenewal = null;
      const devices = snapshot.devices.filter(value => (value.deviceId ?? value.device_id) !== deviceId);
      if (deviceListCache) deviceListCache = {...deviceListCache, devices: deviceListCache.devices.filter(value => value.deviceId !== deviceId)};
      licenseCache = {checkedAt: licenseNow(), status: 'device_revoked', certificate: null, bindingId: '', licenseId: previous.licenseCache?.licenseId ?? '', maxDevices: previous.licenseCache?.maxDevices ?? snapshot.devicesMaxDevices ?? 0, leaseToken: '', renewal: null, deviceList: deviceListCache};
      publish({license: {...snapshot.license, status: 'device_revoked', entitlementActive: true, active: false}, devices});
      await saveLicenseCache(); scheduleLicenseCheck(licenseNow() + LICENSE_STATUS_MAX_AGE); return;
    }
    if (hadLease) {certificate = previous.certificate; licenseCache = previous.licenseCache; leaseToken = previous.leaseToken; leaseRenewal = previous.leaseRenewal;}
    await refreshLicenseInternal(!hadLease);
  }),
  refreshLicense: () => operation('license.refresh', () => refreshLicenseInternal()),
};
async function restoreLicenseCache(value: LicenseCache | null): Promise<boolean> {
  if (!cacheShape(value)) return false;
  licenseCache = value; leaseToken = value.leaseToken ?? ''; leaseRenewal = value.renewal ?? null;
  if (value.status === 'valid' && value.certificate) {
    try {
      const attempt = leaseRenewal;
      await acceptCertificate({certificate: value.certificate, device: {bindingId: value.bindingId}, entitlement: {licenseId: value.licenseId, maxDevices: value.maxDevices}, leaseToken: value.leaseToken}, value.checkedAt);
      licenseCache = value; leaseRenewal = attempt;
      restoreDeviceList(value);
      if (attempt) scheduleLicenseCheck(attempt.nextRetryAt || licenseNow());
      return true;
    } catch {licenseCache = value; leaseToken = value.leaseToken ?? ''; leaseRenewal = value.renewal ?? null; return false;}
  }
  if (!['unlicensed', 'expired', 'revoked', 'device_unbound', 'device_revoked', 'device_limit'].includes(value.status) || licenseNow() >= value.checkedAt + LICENSE_STATUS_MAX_AGE) return false;
  licenseCache = value; nextLicenseCheckAt = value.checkedAt + LICENSE_STATUS_MAX_AGE;
  publish({license: {status: value.status, active: false, entitlementActive: ['device_unbound', 'device_limit', 'device_revoked'].includes(value.status)}});
  restoreDeviceList(value);
  return true;
}
async function restoreSession() {
  if (!nativeSession) return;
  publish({busy: true, restoring: true});
  try {
    const value = await sessionTask('restore', () => nativeSession.read());
    if (!value) return;
    const record = validateSavedSession(value);
    savedSession = record;
    if (!networkRetryJob) networkRetry = record.schemaVersion === 2 ? record.networkRetry ?? null : null;
    if (networkRetry?.attempts === MAX_RETRY_COUNT && !networkRetryJob) {await expireNetworkSession(generation); return;}
    if (record.schemaVersion === 2) {
      const clockRestored = !secureTiming || await licenseClock.restore(record.licenseClock);
      const now = licenseNow();
      if (clockRestored && now < record.validatedAt - 120_000) throw {code:'SESSION_INVALID'};
      const windowFresh = clockRestored && now < record.sessionExpiresAt;
      const accessFresh = windowFresh && record.accessExpiresAt > now + REFRESH_AHEAD;
      if (accessFresh) seedSDKSession(record);
      sdkNeedsRestore = !accessFresh;
      licenseCache = record.licenseCache; leaseToken = licenseCache?.leaseToken ?? ''; leaseRenewal = licenseCache?.renewal ?? null;
      publish({user: record.user});
      sessionWritesEnabled = true;
      lastIdentityRefresh = record.validatedAt;
      const cacheRestored = windowFresh && await restoreLicenseCache(record.licenseCache);
      scheduleClockGuard(); scheduleSessionExpiry();
      if (networkRetry) {scheduleNetworkRetry(); if (cacheRestored) return; publish({license:{...snapshot.license,status:'network_error',active:false}}); return;}
      if (cacheRestored) return;
      publish({license:{status:'checking',active:false}});
      try {await refreshLicenseInternal(false, false, true);}
      catch (cause) {
        if (snapshot.user) {
          if (!['device_limit','device_revoked','expired','revoked','unlicensed'].includes(snapshot.license?.status)) publish({license:{...snapshot.license,status:'network_error',active:false}});
          publish({error:message(cause)});
          scheduleLicenseCheck(Math.max(licenseNow()+LEASE_RETRY_DELAY,leaseRenewal?.nextRetryAt??0));
        }
      }
      return;
    }
    const data = await authRequest('auth.session.restore', () => auth.setSession({access_token: record.accessToken, refresh_token: record.refreshToken}), 'auth.session.restore');
    await afterLogin(data.session, true);
  } catch (cause) {
    const code = diagnoseError(cause).resultCode;
    if (['SESSION_INVALID', 'AUTH_REQUIRED', 'INVALID_CREDENTIALS', 'SESSION_STORAGE_INVALID', 'AUTH_USER_NOT_FOUND', 'AUTH_USER_BLOCKED'].includes(code)) {
      try {await forgetSession();} catch {}
    }
    memory.clear(); clearAuthorization(); publish({user: null, error: message(cause)});
  } finally {publish({busy: false, restoring: false});}
}
if (nativeSession && typeof auth.onAuthStateChange === 'function') auth.onAuthStateChange((event, session) => {
  if (event !== 'TOKEN_REFRESHED' || !sessionWritesEnabled || snapshot.restoring || !snapshot.user || String(session?.user?.id) !== snapshot.user.id) return;
  const token = generation;
  void rememberSession(session, token).then(warning => {if (warning && token === generation) publish({error: warning});});
});
const startup = restoreSession();
window.addEventListener('pagehide', () => {if(clockTimer) clearTimeout(clockTimer); if(networkRetryTimer) clearTimeout(networkRetryTimer); generation++; sessionWritesEnabled = false; if (sessionExpiryTimer) clearTimeout(sessionExpiryTimer); if (renewal) clearTimeout(renewal); memory.clear(); certificate = null;});
function refreshIfDue() {
  if (!snapshot.user || snapshot.busy || networkRetry) return;
  const now = licenseNow();
  if (now >= nextLicenseCheckAt || (savedSession?.schemaVersion === 2 && now >= Math.max(savedSession.sessionExpiresAt - LEASE_SAFETY_WINDOW, nextSessionRetryAt))) void refreshInBackground(generation, 0);
}
window.addEventListener('online', () => {
  if (networkRetry) {scheduleNetworkRetry(); return;}
  if (!snapshot.user && savedSession && !snapshot.busy) {void restoreSession(); return;}
  if (nextSessionRetryAt || leaseRenewal?.retryCount) {
    nextSessionRetryAt=0; nextLicenseCheckAt=0;
    if (leaseRenewal) leaseRenewal={...leaseRenewal,nextRetryAt:0};
  }
  if (secureTiming) void checkLicenseTime().then(refreshIfDue); else refreshIfDue();
});
window.addEventListener('vibe-clock-check', () => void checkLicenseTime().then(refreshIfDue));
document.addEventListener('visibilitychange', () => {if (!document.hidden) {if (secureTiming) void checkLicenseTime().then(refreshIfDue); else refreshIfDue();}});
export default service;
