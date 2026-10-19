import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInterviewPrompt, parseInterviewResponse } from '../ai/interview.js';

test('parseInterviewResponse 解析纯 JSON 提问', () => {
  const r = parseInterviewResponse(
    JSON.stringify({ say: '你想写哪种类型？', options: ['玄幻', '悬疑'], done: false, brief: '' }),
  );
  assert.equal(r.say, '你想写哪种类型？');
  assert.deepEqual(r.options, ['玄幻', '悬疑']);
  assert.equal(r.done, false);
});

test('parseInterviewResponse 去掉 markdown 代码块', () => {
  const raw = '```json\n' + JSON.stringify({ say: '问你个事', options: [], done: false }) + '\n```';
  assert.equal(parseInterviewResponse(raw).say, '问你个事');
});

test('parseInterviewResponse 忽略解释文字', () => {
  const raw =
    '好的：\n' + JSON.stringify({ say: '想写什么？', options: [], done: false, brief: '' }) + '\n以上';
  assert.equal(parseInterviewResponse(raw).say, '想写什么？');
});

test('parseInterviewResponse 过滤空选项并最多保留 4 个', () => {
  const r = parseInterviewResponse(
    JSON.stringify({
      say: 'x',
      options: ['a', '', '  ', 'b', 'c', 'd', 'e', 'f'],
      done: false,
    }),
  );
  assert.deepEqual(r.options, ['a', 'b', 'c', 'd']);
});

test('parseInterviewResponse done 为真但没有 brief 时退化为继续对话', () => {
  const r = parseInterviewResponse(
    JSON.stringify({ say: '够了', options: [], done: true, brief: '' }),
  );
  assert.equal(r.done, false, '没有 brief 不能直接生成');
});

test('parseInterviewResponse done 且有 brief 才算完成', () => {
  const r = parseInterviewResponse(
    JSON.stringify({ say: '明白了', options: [], done: true, brief: '一个剑修复仇的故事' }),
  );
  assert.equal(r.done, true);
  assert.equal(r.brief, '一个剑修复仇的故事');
});

test('parseInterviewResponse 对非 JSON 给出友好错误', () => {
  assert.throws(() => parseInterviewResponse('我不想回答这个。'), /没有返回可解析/);
});

test('parseInterviewResponse 对损坏 JSON 给出友好错误', () => {
  assert.throws(() => parseInterviewResponse('{ "say": '), /格式有误/);
});

test('buildInterviewPrompt 带上对话记录与轮数', () => {
  const p = buildInterviewPrompt([
    { role: 'user', content: '我想写一部小说' },
    { role: 'assistant', content: '想写哪种类型？' },
  ]);
  assert.match(p.user, /我想写一部小说/);
  assert.match(p.system, /已经问过 1 轮/);
  assert.match(p.system, /上限 4 轮/);
  assert.match(p.system, /brief/);
});

test('buildInterviewPrompt 空对话时也能构造', () => {
  const p = buildInterviewPrompt([]);
  assert.match(p.user, /还没有开始/);
});
