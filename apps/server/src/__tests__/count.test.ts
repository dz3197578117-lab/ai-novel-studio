import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countWords } from '../db.js';

test('countWords 统计汉字', () => {
  assert.equal(countWords('雪落了三日'), 5);
});

test('countWords 统计英文单词', () => {
  assert.equal(countWords('hello world'), 2);
});

test('countWords 中英混排', () => {
  // 5 个汉字 + 1 个英文词 'hello'
  assert.equal(countWords('雪落了三日 hello'), 6);
});

test('countWords 连续英文按单词计', () => {
  assert.equal(countWords('ab cd ef'), 3);
});

test('countWords 空文本返回 0', () => {
  assert.equal(countWords(''), 0);
});

test('countWords 忽略标点', () => {
  assert.equal(countWords('你好，世界！'), 4);
});

test('countWords 处理多行正文', () => {
  const text = '雪落了三日。\n\n林尘跪在祠堂前。';
  assert.ok(countWords(text) > 10);
});
