import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeLogs } from '../src/codec.js';
import { eventLogs, program, mint } from './helpers.js';

test('keeps u64 piconero exact above Number.MAX_SAFE_INTEGER', () => {
  assert.equal(decodeLogs(eventLogs('DepositMintedEvent', mint))[0].data.amount, '9007199254740993');
});
test('accepts successful CPI events and rejects event-shaped logs from other programs', () => {
  const other = '11111111111111111111111111111111';
  const data = eventLogs('DepositMintedEvent', mint)[1];
  assert.deepEqual(decodeLogs([`Program ${other} invoke [1]`, data, `Program ${other} success`]), []);
  assert.equal(decodeLogs([`Program ${other} invoke [1]`, `Program ${program} invoke [2]`, data,
    `Program ${program} success`, `Program ${other} success`]).length, 1);
});
test('discards events from caught failed CPI invocations and failed ancestors', () => {
  const other = '11111111111111111111111111111111';
  const data = eventLogs('DepositMintedEvent', mint)[1];
  assert.deepEqual(decodeLogs([`Program ${other} invoke [1]`, `Program ${program} invoke [2]`, data,
    `Program ${program} failed: custom program error: 1`, `Program ${other} success`]), []);
  assert.deepEqual(decodeLogs([`Program ${other} invoke [1]`, `Program ${program} invoke [2]`, data,
    `Program ${program} success`, `Program ${other} failed: custom program error: 1`]), []);
});
test('fails closed on truncated logs and truncated known events', () => {
  assert.throws(() => decodeLogs([...eventLogs('DepositMintedEvent', mint).slice(0, 2), 'Log truncated']));
  assert.throws(() => decodeLogs([`Program ${program} invoke [1]`, eventLogs('DepositMintedEvent', mint)[1]]));
  const logs = eventLogs('DepositMintedEvent', mint);
  logs[1] = logs[1].slice(0, -8);
  assert.throws(() => decodeLogs(logs));
});
