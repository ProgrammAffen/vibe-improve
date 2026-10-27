import {RESULT_CODES, diagnoseError, sanitizeDetails} from './diagnostic-contract.mjs';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export const CLIENT_TRACE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIONS = new Set(['status', 'activate', 'bind', 'devices', 'revoke', 'renew']);
const codes = new Set(RESULT_CODES);

export function createRequestDiagnostics(event, { sink = line => console.info(line), now = () => performance.now(), uuid = randomUUID, platformRequestId } = {}) {
  const traceId = uuid();
  const clientTraceId = typeof event?.clientTraceId === 'string' && CLIENT_TRACE_PATTERN.test(event.clientTraceId)
    ? event.clientTraceId.toLowerCase() : undefined;
  const action = ACTIONS.has(event?.action) ? event.action : 'unknown';
  const started = now();
  let finished = false;
  return {
    traceId,
    finish(response, {cause, stage} = {}) {
      if (!finished) {
        finished = true;
        const candidate = response?.ok === true ? 'OK' : response?.error?.code;
        const resultCode = codes.has(candidate) ? candidate : 'SERVICE_UNAVAILABLE';
        const level = resultCode === 'OK' ? 'info' : ['SERVICE_UNAVAILABLE', 'SERVICE_UNCONFIGURED', 'DATA_INTEGRITY_ERROR', 'SIGNING_KEY_INVALID'].includes(resultCode) ? 'error' : 'warn';
        const elapsed = now() - started;
        const durationMs = Number.isFinite(elapsed) ? Math.min(86_400_000, Math.max(0, Math.round(elapsed))) : 0;
        const detail = response?.ok === true ? sanitizeDetails({stage}) : diagnoseError(cause ?? {code: candidate}, {stage});
        const record = { ...detail, ...sanitizeDetails({providerRequestId: platformRequestId}), schemaVersion: 1, timestamp: new Date().toISOString(), level, event: 'license_request', traceId, ...(clientTraceId && { clientTraceId }), action, durationMs, resultCode };
        try { sink(JSON.stringify(record)); } catch {}
      }
      return { ...response, traceId, ...(clientTraceId && { clientTraceId }) };
    },
  };
}
