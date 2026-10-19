import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCredentials } from '../repos/dsh.js';

const SAMPLE = `version: 1
records:
  client-connection/browser-session:
    kind: grant
    payload:
      version: 1
      secret: abcdef
  deepseek-account-platform/default:
    kind: grant
    payload:
      version: 1
      token: deadbeef
      issuer: https://platform.deepseek.com
refs:
  DZ31_API_KEY: sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  DEEPSEEK_API_KEY: sk-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
  ANOTHER: not-a-key
`;

test('parseCredentials 解析 refs', () => {
  const r = parseCredentials(SAMPLE);
  assert.equal(r.refs.DZ31_API_KEY, 'sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(r.refs.DEEPSEEK_API_KEY, 'sk-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  assert.ok(!('ANOTHER' in r.refs) === false, 'refs 里的名字都应保留');
});

test('parseCredentials 识别 DeepSeek 账号 token', () => {
  assert.equal(parseCredentials(SAMPLE).hasAccountToken, true);
});

test('parseCredentials 对空内容安全', () => {
  const r = parseCredentials('');
  assert.deepEqual(r.refs, {});
  assert.equal(r.hasAccountToken, false);
});
