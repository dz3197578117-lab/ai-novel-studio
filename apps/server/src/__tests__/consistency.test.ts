import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Chapter, Entity, Foreshadow, Project, TimelineEvent } from '@novelforge/shared';
import { buildConsistencyPrompt, parseConsistencyReport } from '../ai/consistency.js';

const scope = { chapters: 3, entities: 2, foreshadows: 1, timeline: 1 };

test('parseConsistencyReport 解析正常结果', () => {
  const raw = JSON.stringify({
    issues: [
      {
        kind: 'character',
        severity: 'high',
        title: '林尘性格突变',
        detail: '第3章他突然变得油嘴滑舌',
        suggestion: '改回沉默寡言的写法',
        refs: ['第三章 · 药阁少女'],
      },
    ],
  });
  const r = parseConsistencyReport(raw, scope);
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0]!.kind, 'character');
  assert.equal(r.issues[0]!.severity, 'high');
  assert.deepEqual(r.issues[0]!.refs, ['第三章 · 药阁少女']);
  assert.equal(r.scope.chapters, 3);
});

test('parseConsistencyReport 支持空结果', () => {
  const r = parseConsistencyReport('{"issues": []}', scope);
  assert.equal(r.issues.length, 0);
});

test('parseConsistencyReport 去掉代码块与解释文字', () => {
  const raw =
    '好的，检查结果如下：\n```json\n' +
    JSON.stringify({ issues: [{ kind: 'plot', severity: 'low', title: 'x', detail: '', suggestion: '', refs: [] }] }) +
    '\n```\n以上。';
  const r = parseConsistencyReport(raw, scope);
  assert.equal(r.issues.length, 1);
});

test('parseConsistencyReport 把未知 kind/severity 兜底', () => {
  const raw = JSON.stringify({
    issues: [{ kind: 'ufo', severity: 'catastrophic', title: 'x' }],
  });
  const r = parseConsistencyReport(raw, scope);
  assert.equal(r.issues[0]!.kind, 'other');
  assert.equal(r.issues[0]!.severity, 'medium');
});

test('parseConsistencyReport 按严重程度排序', () => {
  const raw = JSON.stringify({
    issues: [
      { kind: 'plot', severity: 'low', title: '低' },
      { kind: 'plot', severity: 'high', title: '高' },
      { kind: 'plot', severity: 'medium', title: '中' },
    ],
  });
  const r = parseConsistencyReport(raw, scope);
  assert.deepEqual(
    r.issues.map((i) => i.title),
    ['高', '中', '低'],
  );
});

test('parseConsistencyReport 对非 JSON 抛出友好错误', () => {
  assert.throws(() => parseConsistencyReport('我拒绝回答', scope), /没有返回可解析/);
});

test('parseConsistencyReport 能救回被截断的结果', () => {
  const raw =
    '{"issues":[{"kind":"plot","severity":"high","title":"问题一","detail":"d","suggestion":"s","refs":[]},{"kind":"plot","severity":"low","tit';
  const r = parseConsistencyReport(raw, scope);
  assert.ok(r.issues.length >= 1);
});

test('buildConsistencyPrompt 带上设定/伏笔/时间线与范围', () => {
  const project = {
    id: 'p1',
    title: '雪落长夜',
    logline: '少年剑修',
    genre: '玄幻',
    styleGuide: '冷峻',
    targetWords: 0,
    status: 'drafting',
    createdAt: '',
    updatedAt: '',
  } as Project;
  const entities = [
    { id: 'e1', projectId: 'p1', type: 'character', name: '林尘', aliases: ['尘弟'], summary: '主角', fields: [], body: '', pinned: true, createdAt: '', updatedAt: '' },
  ] as Entity[];
  const chapters = [
    { id: 'c1', projectId: 'p1', volumeId: null, title: '第一章', order: 0, outline: '开端', content: '正文内容', status: 'done', wordCount: 4, summary: '摘要', createdAt: '', updatedAt: '' },
  ] as Chapter[];
  const foreshadows = [
    { id: 'f1', projectId: 'p1', title: '北境的塔', detail: '', plantedChapterId: null, plannedChapterId: null, recoveredChapterId: null, status: 'planted', importance: 2, createdAt: '', updatedAt: '' },
  ] as Foreshadow[];
  const timeline = [
    { id: 't1', projectId: 'p1', storyTime: '第三年·冬', title: '试剑', detail: '', chapterId: null, importance: 2, createdAt: '', updatedAt: '' },
  ] as TimelineEvent[];

  const p = buildConsistencyPrompt({ project, entities, chapters, foreshadows, timeline });
  assert.match(p.user, /林尘/);
  assert.match(p.user, /北境的塔/);
  assert.match(p.user, /第三年·冬/);
  assert.match(p.user, /正文内容/);
  assert.match(p.system, /JSON/);
  assert.deepEqual(p.scope, { chapters: 1, entities: 1, foreshadows: 1, timeline: 1 });
});
