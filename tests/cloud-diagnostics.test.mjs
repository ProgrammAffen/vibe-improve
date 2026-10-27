import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestDiagnostics } from '../cloud/functions/license-api/diagnostics.mjs';
import { requestFromEvent } from '../cloud/functions/license-api/cloud-auth.mjs';

const trace = 'dd6f4556-e988-48c6-9876-61491553d615';
const clientTrace = '9749be68-9784-482f-8d6d-7efbc72af76a';

test('cloud request log projects safe fields and independently correlates one completion', () => {
  const lines = [];
  let time = 5;
  const request = createRequestDiagnostics({
    action: 'activate', clientTraceId: clientTrace, email: 'private@example.invalid',
    userId: 'private-user', activationCode: 'private-code', deviceId: 'private-device',
    token: 'private-token', body: { privateKey: 'private-key' },
  }, {sink: line => lines.push(line), now: () => time, uuid: () => trace});
  time = 19.4;
  const result = request.finish({ok: true, data: {certificate: 'private-certificate'}});
  request.finish({ok: false, error: {code: 'SERVICE_UNAVAILABLE'}});
  assert.equal(lines.length, 1);
  assert.deepEqual(result, {ok: true, data: {certificate: 'private-certificate'}, traceId: trace, clientTraceId: clientTrace});
  const {timestamp, ...record} = JSON.parse(lines[0]);
  assert.ok(Number.isFinite(Date.parse(timestamp)));
  assert.deepEqual(record, {schemaVersion: 1, level: 'info', event: 'license_request', traceId: trace, clientTraceId: clientTrace, action: 'activate', durationMs: 14, resultCode: 'OK'});
  assert.ok(!lines[0].includes('private-'));
  assert.ok(!lines[0].includes('example.invalid'));
});

test('unknown codes, actions and trace injection never become log text', () => {
  const lines = [];
  const request = createRequestDiagnostics({action: 'token=private', clientTraceId: 'secret\npassword'}, {sink: line => lines.push(line), now: () => Infinity, uuid: () => trace});
  const result = request.finish({ok: false, error: {code: 'private-token', message: 'secret', stack: 'secret'}});
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.resultCode, 'SERVICE_UNAVAILABLE');
  assert.equal(entry.action, 'unknown');
  assert.equal(entry.durationMs, 0);
  assert.equal(entry.level, 'error');
  assert.ok(!('clientTraceId' in result));
  assert.ok(!lines[0].includes('secret'));
  assert.ok(!lines[0].includes('private'));
});

test('known cloud failures stay diagnosable and logging failure does not alter the response', () => {
  const lines = [];
  const request = createRequestDiagnostics({action: 'bind'}, {sink: line => lines.push(line), uuid: () => trace});
  request.finish({ok: false, error: {code: 'DEVICE_LIMIT_REACHED', retryable: false}});
  assert.equal(JSON.parse(lines[0]).resultCode, 'DEVICE_LIMIT_REACHED');
  assert.equal(JSON.parse(lines[0]).level, 'warn');
  const broken = createRequestDiagnostics({}, {sink: () => {throw new Error('private disk error');}, uuid: () => trace});
  assert.deepEqual(broken.finish({ok: true, data: {}}), {ok: true, data: {}, traceId: trace});
});

test('client trace metadata strips only after UUID validation while unknown business fields remain', () => {
  const source = {action: 'status', clientTraceId: clientTrace, tcbContext: {fake: 'user'}, unknown: 'remains-rejected-by-service'};
  assert.deepEqual(requestFromEvent(source), {action: 'status', unknown: 'remains-rejected-by-service'});
  assert.equal(source.clientTraceId, clientTrace);
  for (const clientTraceId of ['', 'token', null, 123, {}, '00000000-0000-0000-0000-000000000000']) {
    assert.throws(() => requestFromEvent({action: 'status', clientTraceId}), error => error.code === 'INVALID_REQUEST');
  }
});
