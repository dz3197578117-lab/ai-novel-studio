import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDraftPrompt, parseDraft } from '../ai/draft.js';

const VALID = {
  title: '雪落长夜',
  logline: '少年剑修追查父亲冤案。',
  genre: '古典玄幻',
  styleGuide: '第三人称限知，冷峻克制。',
  entities: [
    { type: 'character', name: '沈砚', summary: '主角', pinned: true },
    { type: 'wrong_type', name: '某人', summary: '类型非法' },
  ],
  volumes: [{ title: '第一卷', summary: '开端' }],
  chapters: [
    { volumeIndex: 0, title: '第一章', outline: '开局' },
    { volumeIndex: 5, title: '第二章', outline: '越界卷号' },
  ],
};

test('parseDraft 能解析纯 JSON', () => {
  const d = parseDraft(JSON.stringify(VALID));
  assert.equal(d.title, '雪落长夜');
  assert.equal(d.chapters.length, 2);
});

test('parseDraft 能去掉 markdown 代码块', () => {
  const raw = '```json\n' + JSON.stringify(VALID) + '\n```';
  const d = parseDraft(raw);
  assert.equal(d.title, '雪落长夜');
});

test('parseDraft 能忽略 JSON 前后的解释文字', () => {
  const raw = '好的，方案如下：\n' + JSON.stringify(VALID) + '\n希望你喜欢！';
  const d = parseDraft(raw);
  assert.equal(d.genre, '古典玄幻');
});

test('parseDraft 对非 JSON 给出友好错误', () => {
  assert.throws(() => parseDraft('抱歉，我无法完成。'), /没有返回可解析的方案/);
});

test('parseDraft 对损坏 JSON 给出友好错误', () => {
  assert.throws(() => parseDraft('{ "title": "x", '), /格式有误/);
});

test('parseDraft 把越界 volumeIndex 归到第一卷', () => {
  const d = parseDraft(JSON.stringify(VALID));
  assert.equal(d.chapters[1]!.volumeIndex, 0);
});

test('parseDraft 把非法 type 兜底为 character', () => {
  const d = parseDraft(JSON.stringify(VALID));
  assert.equal(d.entities[1]!.type, 'character');
});

test('parseDraft 缺少 volumes 时补一个默认卷', () => {
  const raw = JSON.stringify({ ...VALID, volumes: [] });
  const d = parseDraft(raw);
  assert.ok(d.volumes.length >= 1);
  assert.equal(d.chapters[0]!.volumeIndex, 0);
});

test('parseDraft 没有章节时报错', () => {
  const raw = JSON.stringify({ ...VALID, chapters: [] });
  assert.throws(() => parseDraft(raw), /没有给出章节大纲/);
});

test('parseDraft 没有书名时报错', () => {
  const raw = JSON.stringify({ ...VALID, title: '' });
  assert.throws(() => parseDraft(raw), /没有给出书名/);
});

test('parseDraft 会把超量数据截断', () => {
  const many = {
    ...VALID,
    chapters: Array.from({ length: 200 }, (_, i) => ({
      volumeIndex: 0,
      title: `第${i}章`,
      outline: 'x',
    })),
  };
  const d = parseDraft(JSON.stringify(many));
  assert.ok(d.chapters.length <= 100, `实际 ${d.chapters.length}`);
});

test('buildDraftPrompt 带上需求、题材与章数', () => {
  const p = buildDraftPrompt({ idea: '写一个剑修复仇的故事', genre: '玄幻', chapterCount: 12 });
  assert.match(p.user, /剑修复仇/);
  assert.match(p.user, /玄幻/);
  assert.match(p.user, /12 章/);
  assert.match(p.system, /JSON/);
});

test('buildDraftPrompt 章数会被限制在合理范围', () => {
  const p = buildDraftPrompt({ idea: 'x', chapterCount: 999 });
  assert.match(p.user, /100 章/);
});

test('buildDraftPrompt 支持自定义章数', () => {
  const p = buildDraftPrompt({ idea: 'x', chapterCount: 37 });
  assert.match(p.user, /37 章/);
  // 37 章按每卷 10 章算应规划 4 卷
  assert.match(p.system, /volumes 为 4 卷/);
});

test('buildDraftPrompt 章数最小为 1', () => {
  const p = buildDraftPrompt({ idea: 'x', chapterCount: 0 });
  assert.match(p.user, /1 章/);
});
