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
const { parseFactPoints } = await import('../ai/facts.js');
const { buildConsistencyPrompt } = await import('../ai/consistency.js');
const { parseDraft, parseRefine } = await import('../ai/draft.js');
const { createProject, getProject, listProjects } = await import('../repos/projects.repo.js');
const { createChapter, getChapter, setChapterFacts, setChapterSummary, listPriorSummaries } =
  await import('../repos/chapters.repo.js');
const { addConstraints, listOpenConstraints, setConstraintStatus } = await import(
  '../repos/constraints.repo.js'
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

// ───────────── 写前事实清单 + 写作约束回灌 ─────────────

test('迁移 v5：章节的 facts 默认是空数组', () => {
  const p = createProject({ title: 'facts 默认' });
  const c = createChapter(p.id, { title: '第一章' });
  assert.deepEqual(c.facts, []);
});

test('事实清单解析容忍代码块与前后废话', () => {
  const pts = parseFactPoints(
    '好的，以下是核查点：\n```json\n{"points":[{"point":"皇子称谓","query":"殿下 称谓","mustHave":true}]}\n```',
  );
  assert.equal(pts.length, 1);
  assert.equal(pts[0]!.point, '皇子称谓');
  assert.equal(pts[0]!.query, '殿下 称谓');
  assert.equal(pts[0]!.mustHave, true);
});

test('事实清单的 query 会检索到资料并进入上下文', () => {
  const p = createProject({ title: '事实检索' });
  createDoc(p.id, { title: '制度备忘', content: '明代京畿设顺天府，不称京兆府。' });
  const c = createChapter(p.id, { title: '第一章', outline: '沈砚入京' });
  setChapterFacts(c.id, [{ point: '京畿府名', query: '顺天府 京兆府', mustHave: true }]);

  const ctx = buildContext({
    project: getProject(p.id)!,
    chapter: getChapter(c.id)!,
    mode: 'continue',
  });
  assert.ok(ctx.system.includes('顺天府'), '资料应被检索到');
  assert.ok(
    ctx.memoryUsed.some((m) => m.label.includes('按事实清单检索')),
    '记忆使用里应标明是按事实清单检索的',
  );
});

test('写作约束按文本去重，并注入后续生成', () => {
  const p = createProject({ title: '约束去重' });
  const first = addConstraints(p.id, null, [{ text: '主角不得自称本王' }]);
  const again = addConstraints(p.id, null, [{ text: '主角不得自称本王' }]);
  assert.equal(first, 1);
  assert.equal(again, 0, '重复检查不应堆积相同约束');

  const c = createChapter(p.id, { title: '第一章', outline: '入京' });
  const ctx = buildContext({
    project: getProject(p.id)!,
    chapter: c,
    mode: 'continue',
  });
  assert.ok(ctx.system.includes('主角不得自称本王'));
  assert.ok(ctx.system.includes('此前检查发现的问题'));
});

test('标记已解决的约束不再进入上下文', () => {
  const p = createProject({ title: '约束解决' });
  addConstraints(p.id, null, [{ text: '这条已经改掉了' }]);
  const [c1] = listOpenConstraints(p.id);
  assert.ok(c1);
  setConstraintStatus(c1!.id, 'resolved');
  assert.equal(listOpenConstraints(p.id).length, 0);

  const ch = createChapter(p.id, { title: '第一章', outline: 'o' });
  const ctx = buildContext({ project: getProject(p.id)!, chapter: ch, mode: 'continue' });
  assert.ok(!ctx.system.includes('这条已经改掉了'));
});

// ───────────── 叙述视角 ─────────────

test('未指定视角时不注入守则，保持老作品行为', () => {
  const p = createProject({ title: '默认视角' });
  assert.equal(p.pov, 'auto');
  const c = createChapter(p.id, { title: '第一章', outline: 'o' });
  const ctx = buildContext({ project: getProject(p.id)!, chapter: c, mode: 'continue' });
  assert.ok(!ctx.system.includes('叙述视角（硬性规则）'));
});

test('第一人称设定会注入对应守则', () => {
  const p = createProject({ title: '第一人称', pov: 'first' });
  const c = createChapter(p.id, { title: '第一章', outline: 'o' });
  const ctx = buildContext({ project: getProject(p.id)!, chapter: c, mode: 'continue' });
  assert.ok(ctx.system.includes('叙述视角（硬性规则）'));
  assert.ok(ctx.system.includes('第一人称限知'));
  assert.ok(ctx.system.includes('不得用角色名指代自己'));
  assert.ok(ctx.memoryUsed.some((m) => m.label === '视角守则'));
});

test('多视角会把作者的切换规则一起注入', () => {
  const p = createProject({
    title: '多视角',
    pov: 'multi',
    povNote: '按章切换，单章内不换视角',
  });
  const c = createChapter(p.id, { title: '第一章', outline: 'o' });
  const ctx = buildContext({ project: getProject(p.id)!, chapter: c, mode: 'continue' });
  assert.ok(ctx.system.includes('多视角轮换'));
  assert.ok(ctx.system.includes('按章切换，单章内不换视角'));
});

test('一致性检查以视角设定为基准', () => {
  const p = createProject({ title: '检查基准', pov: 'first' });
  const prompt = buildConsistencyPrompt({
    project: p,
    entities: [],
    chapters: [],
    foreshadows: [],
    timeline: [],
  });
  assert.ok(prompt.user.includes('第一人称限知'));
  assert.ok(prompt.user.includes('判定标准'), '应给出可执行的判定标准');
  assert.ok(prompt.user.includes('合法') || prompt.user.includes('不报'), '应说明合法切换不报');
});

test('视角守则声明「默认 + 允许的切换」，不是全书唯一', () => {
  const p = createProject({
    title: '可切换',
    pov: 'third-limited',
    povNote: '每卷最后一章切到反派视角，另起一节并以人名开头',
  });
  const c = createChapter(p.id, { title: '第一章', outline: 'o' });
  const ctx = buildContext({ project: getProject(p.id)!, chapter: c, mode: 'continue' });

  assert.ok(ctx.system.includes('默认'), '应写明是默认视角');
  assert.ok(ctx.system.includes('允许的切换'), '应给出例外条款');
  assert.ok(ctx.system.includes('每卷最后一章切到反派视角'), '应带上作者写的规则');
  assert.ok(ctx.system.includes('标记'), '应要求可辨识的切换标记');
});

test('未写切换规则时给出默认口子（换章/分节/时空跳转）', () => {
  const p = createProject({ title: '默认口子', pov: 'first' });
  const c = createChapter(p.id, { title: '第一章', outline: 'o' });
  const ctx = buildContext({ project: getProject(p.id)!, chapter: c, mode: 'continue' });
  assert.ok(ctx.system.includes('章节开头'));
  assert.ok(ctx.system.includes('分节'));
});

// ───────────── 章节级视角覆盖 ─────────────

test('标题是楔子/序章的新章节自动设为全知', () => {
  const p = createProject({ title: '楔子自动', pov: 'third-limited' });
  const prologue = createChapter(p.id, { title: '楔子' });
  const normal = createChapter(p.id, { title: '第一章 雪夜' });
  assert.equal(prologue.pov, 'third-omniscient');
  assert.equal(normal.pov, null, '普通章节应继承项目默认');
});

test('章节视角覆盖项目默认，守则改成「本章」', () => {
  const p = createProject({ title: '覆盖生效', pov: 'third-limited' });
  const c = createChapter(p.id, { title: '楔子', outline: '交代二十年前那场大火' });
  const ctx = buildContext({ project: getProject(p.id)!, chapter: c, mode: 'continue' });

  assert.ok(ctx.system.includes('第三人称全知'), '应用本章的全知守则');
  assert.ok(ctx.system.includes('本章'), '应标明是本章的视角');
  assert.ok(!ctx.system.includes('本书**默认**'), '覆盖时不该再套项目默认');
});

test('普通章节仍用项目默认视角', () => {
  const p = createProject({ title: '继承默认', pov: 'third-limited' });
  const c = createChapter(p.id, { title: '第一章', outline: 'o' });
  const ctx = buildContext({ project: getProject(p.id)!, chapter: c, mode: 'continue' });
  assert.ok(ctx.system.includes('本书**默认**'));
  assert.ok(ctx.system.includes('允许的切换'));
});

test('一致性检查会列出单独设了视角的章节', () => {
  const p = createProject({ title: '检查覆盖', pov: 'third-limited' });
  const pro = createChapter(p.id, { title: '楔子', outline: 'o' });
  const c1 = createChapter(p.id, { title: '第一章', outline: 'o' });

  const prompt = buildConsistencyPrompt({
    project: getProject(p.id)!,
    entities: [],
    chapters: [getChapter(pro.id)!, getChapter(c1.id)!],
    foreshadows: [],
    timeline: [],
  });
  assert.ok(prompt.user.includes('楔子：第三人称全知'));
  assert.ok(prompt.user.includes('不要按项目默认报错'));
});

test('AI 方案里的视角会被解析，非法值直接忽略', () => {
  const ok = parseDraft(
    JSON.stringify({
      title: '雪落长夜',
      logline: '',
      genre: '',
      styleGuide: '',
      pov: 'multi',
      povNote: '按卷切换',
      entities: [],
      volumes: [{ title: '第一卷', summary: '' }],
      chapters: [{ volumeIndex: 0, title: '第一章', outline: 'o' }],
    }),
  );
  assert.equal(ok.pov, 'multi');
  assert.equal(ok.povNote, '按卷切换');

  const bad = parseDraft(
    JSON.stringify({
      title: '雪落长夜',
      pov: '上帝视角',
      volumes: [{ title: '第一卷' }],
      chapters: [{ volumeIndex: 0, title: '第一章' }],
    }),
  );
  assert.equal(bad.pov, undefined, '不在白名单的视角应当被丢弃');
});

// ───────────── 对话中精修方案 ─────────────

test('方案精修只取允许改动的字段，章节多时不许动章节', () => {
  const raw = JSON.stringify({
    reply: '改了书名',
    draft: {
      title: '新书名',
      logline: '新简介',
      volumes: [{ title: '卷一', summary: '' }],
      chapters: [{ volumeIndex: 0, title: '偷偷加的章', outline: 'x' }],
    },
  });
  const r = parseRefine(raw, false);
  assert.ok(r);
  assert.equal(r!.reply, '改了书名');
  assert.equal(r!.patch.title, '新书名');
  assert.equal(r!.patch.chapters, undefined, '不允许改章节时不该带回 chapters');
});

test('章节不多时允许精修改动章节', () => {
  const raw = JSON.stringify({
    reply: '加了一章',
    draft: {
      title: '书',
      volumes: [{ title: '卷一', summary: '' }],
      chapters: [{ volumeIndex: 0, title: '第一章', outline: 'o' }],
    },
  });
  const r = parseRefine(raw, true);
  assert.ok(r);
  assert.equal(r!.patch.chapters?.length, 1);
});
