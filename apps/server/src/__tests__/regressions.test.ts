import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 针对本轮修复的回归测试。
 * 每条都对应一个曾经真实存在的问题，改回去就会红。
 */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novelforge-reg-'));
process.env.NOVELFORGE_DATA_DIR = dataDir;

const { getDb, transaction } = await import('../db.js');
const { buildContext } = await import('../ai/context.js');
const { createProject, getProject, listProjects } = await import('../repos/projects.repo.js');
const { createChapter, setChapterSummary, listPriorSummaries } = await import(
  '../repos/chapters.repo.js'
);
const { createDoc, searchKnowledge } = await import('../repos/layers.repo.js');
const { profileInput } = await import('../routes/schemas.js');

before(() => {
  getDb();
});

after(() => {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* Windows 上 WAL 文件可能短暂占用，忽略 */
  }
});

test('baseUrl 只接受 http(s)：file:// 与垃圾字符串被拒', () => {
  const bad = ['file:///etc/passwd', '不是地址', '', 'ftp://x.com/v1'];
  for (const baseUrl of bad) {
    const r = profileInput.safeParse({ name: 'x', baseUrl, model: 'm' });
    assert.equal(r.success, false, `${baseUrl} 不该通过`);
  }
  for (const baseUrl of ['https://api.deepseek.com/v1', 'http://127.0.0.1:11434/v1']) {
    const r = profileInput.safeParse({ name: 'x', baseUrl, model: 'm' });
    assert.equal(r.success, true, `${baseUrl} 应该通过`);
  }
});

test('事务失败时整体回滚，不留半条数据', () => {
  const before = listProjects().length;
  assert.throws(() =>
    transaction(() => {
      createProject({ title: '写进事务但注定失败' });
      throw new Error('boom');
    }),
  );
  assert.equal(listProjects().length, before, '事务内创建的作品应该被回滚');
  assert.ok(!listProjects().some((p) => p.title === '写进事务但注定失败'));
});

test('嵌套事务复用外层事务，不会因 BEGIN 嵌套报错', () => {
  const title = '嵌套事务';
  transaction(() => {
    transaction(() => createProject({ title }));
  });
  assert.ok(listProjects().some((p) => p.title === title));
});

test('超长硬约束被截断，但不会把前情提要挤出上下文', () => {
  const p = createProject({ title: '长篇', rules: '规'.repeat(30_000) });
  const c1 = createChapter(p.id, { title: '第一章', outline: '开头' });
  setChapterSummary(c1.id, '主角被逐出家门，雪夜离族。');
  const c2 = createChapter(p.id, { title: '第二章', outline: '接续' });

  const ctx = buildContext({ project: getProject(p.id)!, chapter: c2, mode: 'continue' });

  // 硬约束被截到上限，而不是原样塞入 3 万字
  const rulesItem = ctx.memoryUsed.find((m) => m.label === '作者硬约束');
  assert.ok(rulesItem, '应该记录了硬约束的用量');
  assert.ok(rulesItem!.chars < 30_000, '硬约束应被截断');
  assert.ok(ctx.system.includes('已截断'));

  // 关键：前情提要不因为硬约束太长而整段消失
  assert.ok(ctx.system.includes('前情提要'), '前情提要不应被硬约束挤掉');
  assert.ok(ctx.system.includes('主角被逐出家门'));
});

test('预算如实反映必选项的消耗', () => {
  const p = createProject({ title: '预算', rules: '规'.repeat(2000) });
  const c = createChapter(p.id, { title: '第一章', outline: '大'.repeat(1000) });
  const ctx = buildContext({
    project: getProject(p.id)!,
    chapter: c,
    mode: 'continue',
    memoryBudget: 10_000,
  });
  const used = ctx.memoryUsed.reduce((s, m) => s + m.chars, 0);
  assert.ok(used >= 2500, `必选项计入后合计应超过 2500，实际 ${used}`);
});

test('前情摘要单条放不下时跳过它，而不是放弃整段', () => {
  const p = createProject({ title: '摘要降级' });
  const c1 = createChapter(p.id, { title: '第一章', outline: 'o' });
  const c2 = createChapter(p.id, { title: '第二章', outline: 'o' });
  const c3 = createChapter(p.id, { title: '第三章', outline: 'o' });
  // 最近的一章摘要特别长，早的两章很短
  setChapterSummary(c1.id, '早期剧情。');
  setChapterSummary(c2.id, '中间剧情。');
  setChapterSummary(c3.id, '近'.repeat(9000));

  const target = createChapter(p.id, { title: '第四章', outline: 'o' });
  const priors = listPriorSummaries(p.id, target.order, 30);
  assert.equal(priors[0]!.title, '第三章', '最新的应排在最前');

  const ctx = buildContext({
    project: getProject(p.id)!,
    chapter: target,
    mode: 'continue',
    memoryBudget: 9_000,
  });
  // 长摘要被跳过，但更早的短摘要仍在
  assert.ok(ctx.system.includes('早期剧情'), '更早的短摘要应该被保留');
});

test('知识库检索不会把 % 和 _ 当成 SQL 通配符', () => {
  const p = createProject({ title: '通配符' });
  createDoc(p.id, { title: '折扣表', content: '全场商品 5% 折扣\n\n另一个不相干的段落' });
  createDoc(p.id, { title: '普通文档', content: '完全无关的内容，没有任何符号' });

  const hits = searchKnowledge(p.id, '%', 5);
  assert.equal(hits.length, 1, '只应命中真正含 % 的那一段');
  assert.ok(hits[0]!.text.includes('%'));
});
