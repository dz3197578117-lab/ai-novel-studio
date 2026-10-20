import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripLeadingHeading } from '../routes/write.routes.js';

test('去掉 # 标题行', () => {
  const t = '# 第三章 · 东市摆摊\n\n天没亮我就把福顺薅了起来。';
  assert.equal(stripLeadingHeading(t), '天没亮我就把福顺薅了起来。');
});

test('去掉不带 # 的标题行', () => {
  const t = '第三章 · 东市摆摊\n天没亮我就把福顺薅了起来。';
  assert.equal(stripLeadingHeading(t), '天没亮我就把福顺薅了起来。');
});

test('去掉中文数字章节名', () => {
  const t = '## 第十二章 试剑\n正文开始。';
  assert.equal(stripLeadingHeading(t), '正文开始。');
});

test('去掉开头的分隔线', () => {
  const t = '---\n正文开始。';
  assert.equal(stripLeadingHeading(t), '正文开始。');
});

test('正常正文不受影响', () => {
  const t = '天没亮我就把福顺薅了起来。倒不是我有起早的习惯。';
  assert.equal(stripLeadingHeading(t), t);
});

test('正文中间提到的「第三章」不受影响', () => {
  const t = '我翻到第三章，上面写着名字。';
  assert.equal(stripLeadingHeading(t), t);
});
