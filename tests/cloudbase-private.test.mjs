import test from 'node:test';
import assert from 'node:assert/strict';
import { unpackCloudData } from '../scripts/cloudbase-api-private.mjs';

test('CloudBase admin query decodes nested response envelopes and license device limits', () => {
  const input = [JSON.stringify([JSON.stringify({ _id: 'test-hash', maxDevices: { $numberInt: '2' }, features: ['app.access'] })])];
  assert.deepEqual(unpackCloudData(input), [{ _id: 'test-hash', maxDevices: 2, features: ['app.access'] }]);
});

test('CloudBase admin query preserves numeric identifiers and integers beyond Number precision', () => {
  assert.deepEqual(unpackCloudData({ _id: '1886961444555767809', value: { $numberLong: '9007199254740993' } }), {
    _id: '1886961444555767809', value: { $numberLong: '9007199254740993' },
  });
});
