import {RESULT_CODES, sanitizeDetails, diagnoseError, type DiagnosticDetails} from '../../../cloud/functions/license-api/diagnostic-contract.mjs';
const STORAGE_KEY = 'vibe-improve.diagnostics.v1';
export const LOG_LIMITS = Object.freeze({entries: 300, bytes: 256 * 1024});
const events = ['app.started', 'operation.started', 'operation.completed', 'operation.failed', 'cloud.started', 'cloud.completed', 'cloud.failed', 'background.started', 'background.completed', 'background.failed', 'runtime.error', 'runtime.unhandled_rejection'] as const;
const operations = ['project.storage', 'auth.login', 'auth.registration.send', 'auth.registration.verify', 'auth.password.reset.send', 'auth.password.reset', 'auth.password.change.send', 'auth.password.change', 'auth.logout', 'auth.session.refresh', 'auth.session.restore', 'auth.session.persist', 'auth.session.clear', 'auth.identity.read', 'license.activate', 'license.bind', 'license.revoke', 'license.refresh', 'license.status', 'license.devices', 'license.renew', 'license.certificate.verify'] as const;
const levels = ['debug', 'info', 'warn', 'error'] as const;
const resultCodes = RESULT_CODES;
const licenseStatuses = ['valid', 'unlicensed', 'expired', 'revoked', 'device_limit', 'device_unbound', 'device_revoked', 'offline_valid', 'renewal_retry', 'lease_expired', 'network_error', 'checking', 'invalid'] as const;
export type DiagnosticOperation = typeof operations[number];
export type DiagnosticEntry = DiagnosticDetails & {
  schemaVersion: 1;
  timestamp: string;
  level: typeof levels[number];
  event: typeof events[number];
  sessionId: string;
  traceId?: string;
  operation?: DiagnosticOperation;
  durationMs?: number;
  resultCode?: typeof resultCodes[number];
  licenseStatus?: typeof licenseStatuses[number];
};
type Fields = DiagnosticDetails & Partial<Pick<DiagnosticEntry, 'level' | 'traceId' | 'operation' | 'durationMs' | 'resultCode' | 'licenseStatus'>>;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function oneOf<T extends string>(value: unknown, values: readonly T[]): value is T {return typeof value === 'string' && values.includes(value as T);}
function uuid(value: unknown): value is string {return typeof value === 'string' && uuidPattern.test(value);}
function newId() {
  try {return crypto.randomUUID();}
  catch {return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {const value = Math.floor(Math.random() * 16); return (character === 'x' ? value : (value & 3) | 8).toString(16);});}
}
const sessionId = newId();
function sanitize(value: unknown): DiagnosticEntry | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== 1 || !oneOf(input.event, events) || !oneOf(input.level, levels) || !uuid(input.sessionId)) return null;
  if (typeof input.timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.timestamp) || !Number.isFinite(Date.parse(input.timestamp))) return null;
  const entry: DiagnosticEntry = {schemaVersion: 1, timestamp: input.timestamp, level: input.level, event: input.event, sessionId: input.sessionId};
  if (uuid(input.traceId)) entry.traceId = input.traceId;
  if (oneOf(input.operation, operations)) entry.operation = input.operation;
  if (typeof input.durationMs === 'number' && Number.isFinite(input.durationMs)) entry.durationMs = Math.round(Math.min(86_400_000, Math.max(0, input.durationMs)));
  if (oneOf(input.resultCode, resultCodes)) entry.resultCode = input.resultCode;
  if (oneOf(input.licenseStatus, licenseStatuses)) entry.licenseStatus = input.licenseStatus;
  return Object.assign(entry, sanitizeDetails(input));
}
function bounded(input: DiagnosticEntry[]) {
  const entries = input.slice(-LOG_LIMITS.entries);
  while (entries.length && JSON.stringify(entries).length > LOG_LIMITS.bytes) entries.shift();
  return entries;
}
function restore(): DiagnosticEntry[] {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved || saved.length > LOG_LIMITS.bytes) return [];
    const parsed: unknown = JSON.parse(saved);
    if (!Array.isArray(parsed)) return [];
    return bounded(parsed.slice(-LOG_LIMITS.entries).map(sanitize).filter((entry): entry is DiagnosticEntry => entry !== null));
  } catch {return [];}
}
let entries = restore();
function persist() {try {localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));} catch {}}
export function logEvent(event: DiagnosticEntry['event'], fields: Fields = {}): DiagnosticEntry | undefined {
  try {
    const entry = sanitize({...fields, schemaVersion: 1, timestamp: new Date().toISOString(), level: fields.level ?? 'info', event, sessionId});
    if (!entry) return;
    entries = bounded([...entries, entry]);
    persist();
    try {console.info('VI_DIAGNOSTIC ' + JSON.stringify(entry));} catch {}
    try {window.vibeNative?.log?.({...entry});} catch {}
    return {...entry};
  } catch {return;}
}
export function diagnosticResultCode(cause: unknown): string {return diagnoseError(cause).resultCode;}
export function diagnosticSpan(operation: DiagnosticOperation, kind: 'operation' | 'cloud' | 'background' = 'operation', traceId = newId(), context: Fields = {}) {
  const start = Date.now();
  let completed = false;
  logEvent(`${kind}.started`, {...context, operation, traceId});
  function finish(failed: boolean, fields: Fields) {
    if (completed) return;
    completed = true;
    logEvent(failed ? `${kind}.failed` : `${kind}.completed`, {...context, ...fields, level: failed ? 'error' : 'info', operation, traceId, durationMs: Date.now() - start});
  }
  return {traceId, succeed: (fields: Fields = {}) => finish(false, {...fields, resultCode: fields.resultCode ?? 'OK'}), fail: (cause: unknown, fields: Fields = {}) => finish(true, {...diagnoseError(cause, {stage: fields.stage ?? context.stage, verification: /verify$/.test(fields.stage ?? context.stage ?? ''), offline: typeof navigator !== 'undefined' && navigator.onLine === false}), ...fields})};
}
export const diagnostics = Object.freeze({
  getEntries: () => entries.map(entry => ({...entry})),
  exportText: () => JSON.stringify({schemaVersion: 1, exportedAt: new Date().toISOString(), entries}, null, 2),
  clear: () => {
    entries = [];
    try {localStorage.removeItem(STORAGE_KEY);} catch {persist();}
  },
});
let installed = false;
export {diagnoseError};
export function installGlobalDiagnostics() {
  if (installed) return;
  installed = true;
  window.addEventListener('error', event => {logEvent('runtime.error', {...diagnoseError(event.error, {stage: 'runtime.global'}), level: 'error', resultCode: 'RUNTIME_ERROR'});});
  window.addEventListener('unhandledrejection', event => {logEvent('runtime.unhandled_rejection', {...diagnoseError(event.reason, {stage: 'runtime.global'}), level: 'error', resultCode: 'UNHANDLED_REJECTION'});});
  logEvent('app.started');
}
