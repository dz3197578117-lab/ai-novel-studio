import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Chapter, Project } from '@novelforge/shared';
import { buildContext, summaryPrompt } from '../ai/context.js';

function makeProject(over: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    title: '测试之书',
    logline: '一句话简介',
    genre: '玄幻',
    targetWords: 100000,
    status: 'drafting',
    styleGuide: '冷峻克制',
    createdAt: '',
    updatedAt: '',
    ...over,
  };
}

function makeChapter(over: Partial<Chapter> = {}): Chapter {
  return {
    id: 'c1',
    projectId: 'p1',
    volumeId: null,
    title: '第一章',
    order: 0,
    outline: '主角被逐出家门',
    content: '雪落了三日。',
    status: 'drafting',
    wordCount: 6,
    summary: '',
    createdAt: '',
    updatedAt: '',
    ...over,
  };
}

test('上下文一定包含文风、大纲、书名', () => {
  const ctx = buildContext({ project: makeProject(), chapter: makeChapter(), mode: 'continue' });
  assert.ok(ctx.system.includes('文风要求'));
  assert.ok(ctx.system.includes('冷峻克制'));
  assert.ok(ctx.system.includes('本章大纲'));
  assert.ok(ctx.system.includes('主角被逐出家门'));
  assert.ok(ctx.system.includes('测试之书'));
});

test('文风为空时回退到默认文风', () => {
  const ctx = buildContext({
    project: makeProject({ styleGuide: '' }),
    chapter: makeChapter(),
    mode: 'continue',
  });
  assert.ok(ctx.system.includes('自然流畅'));
});

test('续写模式带上前文结尾，且不会塞入整章', () => {
  const longContent = 'A'.repeat(3000) + '\n结尾的这一句。';
  const ctx = buildContext({
    project: makeProject(),
    chapter: makeChapter({ content: longContent }),
    mode: 'continue',
  });
  assert.ok(ctx.user.includes('本章已有正文'));
  assert.ok(ctx.user.includes('结尾的这一句'));
  assert.ok(ctx.user.length < longContent.length);
});

test('改写模式优先使用选中片段而非全文', () => {
  const ctx = buildContext({
    project: makeProject(),
    chapter: makeChapter({ content: '原有正文内容' }),
    mode: 'rewrite',
    selection: '被选中的片段',
  });
  assert.ok(ctx.user.includes('被选中的片段'));
  assert.ok(!ctx.user.includes('本章已有正文'));
});

test('用户额外指令会进入提示词', () => {
  const ctx = buildContext({
    project: makeProject(),
    chapter: makeChapter(),
    mode: 'expand',
    instruction: '多写一点环境',
  });
  assert.ok(ctx.user.includes('多写一点环境'));
});

test('空正文且无选区时给出开始写作指令', () => {
  const ctx = buildContext({
    project: makeProject(),
    chapter: makeChapter({ content: '', outline: '新的一章' }),
    mode: 'continue',
  });
  assert.ok(ctx.user.includes('开始写作'));
});

test('记忆预算更小时上下文不会更长', () => {
  const tiny = buildContext({
    project: makeProject(),
    chapter: makeChapter(),
    mode: 'continue',
    memoryBudget: 500,
  });
  const large = buildContext({
    project: makeProject(),
    chapter: makeChapter(),
    mode: 'continue',
    memoryBudget: 50000,
  });
  assert.ok(tiny.system.length <= large.system.length);
});

test('记忆使用记录包含大纲条目', () => {
  const ctx = buildContext({ project: makeProject(), chapter: makeChapter(), mode: 'continue' });
  assert.ok(Array.isArray(ctx.memoryUsed));
  assert.ok(ctx.memoryUsed.some((m) => m.label === '本章大纲'));
});

test('不同模式给出不同指令', () => {
  const cont = buildContext({ project: makeProject(), chapter: makeChapter(), mode: 'continue' });
  const polish = buildContext({ project: makeProject(), chapter: makeChapter(), mode: 'polish' });
  assert.ok(cont.system.includes('续写'));
  assert.ok(polish.system.includes('润色'));
});

test('摘要提示词会截断超长正文', () => {
  const p = summaryPrompt(makeChapter({ content: 'B'.repeat(20000) }));
  assert.ok(p.user.length < 20000);
  assert.ok(p.system.includes('摘要'));
});
