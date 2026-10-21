import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Chapter, NovelDraft, Project } from '@novelforge/shared';

/**
 * 针对本轮修复的回归测试。
 * 每条都对应一个曾经真实存在的问题，改回去就会红。
 */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novelforge-reg-'));
process.env.NOVELFORGE_DATA_DIR = dataDir;

const { getDb, transaction } = await import('../db.js');
const { buildContext } = await import('../ai/context.js');
const { parseFactPoints } = await import('../ai/facts.js');
const { joinUrl, takeSseEvent } = await import('../ai/client.js');
const { buildConsistencyPrompt, sampleChaptersForCheck } = await import('../ai/consistency.js');
const { parseDraft, parseRefine } = await import('../ai/draft.js');
const { createProject, getProject, listProjects } = await import('../repos/projects.repo.js');
const {
  createChapter,
  getChapter,
  getLastChapterContent,
  listChapterDigests,
  setChapterFacts,
  setChapterSummary,
  listPriorSummaries,
} = await import('../repos/chapters.repo.js');
const { addConstraints, listConstraints, listOpenConstraints, setConstraintStatus } = await import(
  '../repos/constraints.repo.js'
);
const { chunkText, createDoc, deleteDoc, reindexKnowledgeIfNeeded, searchKnowledge } = await import(
  '../repos/layers.repo.js'
);
const { cancelJob, createJob, getJob, markRunningJobsInterrupted, patchJob } = await import(
  '../services/jobs.js'
);
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

test('楔子/序章不再自动改成全知，默认继承项目视角', () => {
  const p = createProject({ title: '楔子继承', pov: 'first' });
  const prologue = createChapter(p.id, { title: '楔子' });
  const normal = createChapter(p.id, { title: '第一章 雪夜' });
  assert.equal(prologue.pov, null, '第一人称作品的楔子不应被强制全知');
  assert.equal(normal.pov, null, '普通章节应继承项目默认');
});

test('章节视角覆盖项目默认，守则改成「本章」', () => {
  const p = createProject({ title: '覆盖生效', pov: 'third-limited' });
  const c = createChapter(p.id, { title: '楔子', outline: '交代二十年前那场大火', pov: 'third-omniscient' });
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
  const pro = createChapter(p.id, { title: '楔子', outline: 'o', pov: 'third-omniscient' });
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

// ───────────── 方案精修不丢作者手动内容 ─────────────

const BASE_DRAFT: NovelDraft = {
  title: '旧书名',
  logline: '旧简介',
  genre: '玄幻',
  styleGuide: '冷峻克制',
  pov: 'third-limited',
  povNote: '每卷最后一章切反派',
  entities: [
    {
      type: 'character',
      name: '沈砚',
      aliases: ['砚哥'],
      summary: '主角',
      fields: [{ key: '年龄', value: '17' }],
      body: '详细设定：出身寒门，左手有旧伤。',
      pinned: true,
    },
  ],
  volumes: [{ title: '第一卷', summary: '入京' }],
  chapters: [{ volumeIndex: 0, title: '第一章', outline: '雪夜入京' }],
};

test('精修时模型没返回的字段保持原样，不被清空', () => {
  const raw = JSON.stringify({
    reply: '改了书名',
    draft: { title: '新书名' },
  });
  const r = parseRefine(raw, false, BASE_DRAFT);
  assert.ok(r);
  assert.equal(r!.patch.title, '新书名');
  assert.equal(r!.patch.logline, undefined, '未返回的简介不应被清空');
  assert.equal(r!.patch.styleGuide, undefined);
  assert.equal(r!.patch.povNote, undefined);
  assert.equal(r!.patch.entities, undefined, '未返回设定时不应替换整组设定');
});

test('精修返回精简设定时，正文/结构化字段/别名/固定状态沿用原值', () => {
  const raw = JSON.stringify({
    reply: '改了主角摘要',
    draft: {
      entities: [{ type: 'character', name: '沈砚', summary: '改过的摘要' }],
    },
  });
  const r = parseRefine(raw, false, BASE_DRAFT);
  assert.ok(r);
  const e = r!.patch.entities![0]!;
  assert.equal(e.summary, '改过的摘要');
  assert.equal(e.body, BASE_DRAFT.entities[0]!.body, '设定正文不能被清空');
  assert.equal(e.fields?.length, 1, '结构化字段不能被清空');
  assert.equal(e.aliases?.[0], '砚哥', '别名不能被清空');
  assert.equal(e.pinned, true, '固定状态不能被清空');
});

// ───────────── 模型端点拼接 / SSE 分帧 ─────────────

test('粘贴完整 /chat/completions 地址时，模型列表仍拼到 /v1/models', () => {
  assert.equal(
    joinUrl('https://api.deepseek.com/v1/chat/completions', '/models'),
    'https://api.deepseek.com/v1/models',
  );
  assert.equal(
    joinUrl('https://api.deepseek.com/v1/chat/completions', '/chat/completions'),
    'https://api.deepseek.com/v1/chat/completions',
  );
  assert.equal(
    joinUrl('https://api.deepseek.com/v1/models', '/chat/completions'),
    'https://api.deepseek.com/v1/chat/completions',
  );
  assert.equal(
    joinUrl('https://api.deepseek.com/v1/', '/chat/completions'),
    'https://api.deepseek.com/v1/chat/completions',
  );
});

test('SSE 同时支持 LF 与 CRLF 分帧，半帧不误判', () => {
  assert.equal(takeSseEvent('data: 不完整'), null);
  assert.deepEqual(takeSseEvent('data: a\n\ndata: b\n\n'), {
    raw: 'data: a',
    rest: 'data: b\n\n',
  });
  assert.deepEqual(takeSseEvent('data: a\r\n\r\ndata: b\r\n\r\n'), {
    raw: 'data: a',
    rest: 'data: b\r\n\r\n',
  });
});

// ───────────── 目录查询不把正文读进内存 ─────────────

test('listChapterDigests 不含正文，最后章正文单独取', () => {
  const p = createProject({ title: '摘要查询' });
  const c1 = createChapter(p.id, { title: '第一章', content: '甲'.repeat(120) });
  const c2 = createChapter(p.id, { title: '第二章', content: '乙'.repeat(80) });

  const digests = listChapterDigests(p.id);
  assert.equal(digests.length, 2);
  assert.ok(digests.every((c) => c.content === ''), '目录查询不应带正文');
  assert.equal(digests[0]!.outline, c1.outline);
  assert.equal(getLastChapterContent(p.id), c2.content);
});

// ───────────── 上下文用量分类 ─────────────

test('上下文用量按规则/规划/文风分类，而不是一律算作文风', () => {
  const p = createProject({ title: '用量分类', rules: '不得自称本王', styleGuide: '冷峻' });
  const c = createChapter(p.id, { title: '第一章', outline: '入京' });
  const ctx = buildContext({ project: getProject(p.id)!, chapter: c, mode: 'continue' });

  assert.equal(ctx.memoryUsed.find((m) => m.label === '作者硬约束')?.kind, 'rule');
  assert.equal(ctx.memoryUsed.find((m) => m.label === '本章大纲')?.kind, 'plan');
  assert.equal(ctx.memoryUsed.find((m) => m.label === '文风要求')?.kind, 'style');
});

// ───────────── 约束批内去重 ─────────────

test('同一次检查里的重复约束只落一条', () => {
  const p = createProject({ title: '批内去重' });
  const n = addConstraints(p.id, null, [
    { text: '主称呼前后不一致' },
    { text: '主称呼前后不一致' },
  ]);
  assert.equal(n, 1);
  assert.equal(listOpenConstraints(p.id).filter((c) => c.text === '主称呼前后不一致').length, 1);
});


// ───────────── 后台任务落库 / 取消 / 重启中断 ─────────────

test('任务进度与部分结果落库，取消后保留 result', () => {
  const p = createProject({ title: '任务落库' });
  const job = createJob<{ done: number }>('toc', { done: 0, total: 2 }, p.id);
  patchJob(job.id, {
    result: { done: 1 },
    progress: { done: 1, total: 2, phase: 'chapters' },
  });

  const row = getDb()
    .prepare('SELECT status, result FROM job_runs WHERE id = ?')
    .get(job.id) as { status: string; result: string };
  assert.equal(row.status, 'running');
  assert.deepEqual(JSON.parse(row.result), { done: 1 });

  const canceled = cancelJob(job.id);
  assert.equal(canceled?.status, 'canceled');
  assert.deepEqual(getJob<{ done: number }>(job.id)?.result, { done: 1 });
});

test('服务重启把 running 任务标成 interrupted，部分结果不丢', () => {
  const p = createProject({ title: '任务中断' });
  const job = createJob<{ done: number }>('volume', { done: 0, total: 3 }, p.id);
  patchJob(job.id, { result: { done: 2 } });

  markRunningJobsInterrupted();

  const after = getJob<{ done: number }>(job.id);
  assert.equal(after?.status, 'interrupted');
  assert.deepEqual(after?.result, { done: 2 });
});


// ───────────── P1：约束作用域/过期、全书抽样、引用落库、重叠分块 ─────────────

test('后期发现的约束不会注入到早期章节', () => {
  const p = createProject({ title: '约束作用域' });
  addConstraints(p.id, null, [{ text: '第 50 章之后才成立的规则' }], { applyFromOrder: 50 });

  const early = listOpenConstraints(p.id, 8, 3);
  assert.ok(!early.some((c) => c.text.includes('第 50 章')), '第 3 章不该收到后期限定');

  const later = listOpenConstraints(p.id, 8, 50);
  assert.ok(later.some((c) => c.text.includes('第 50 章')), '第 50 章应收到');
});

test('过期约束自动标记解决，不再注入', () => {
  const p = createProject({ title: '约束过期' });
  addConstraints(p.id, null, [{ text: '这条已经过期' }], { ttlDays: -1 });
  const open = listOpenConstraints(p.id, 8, 999);
  assert.equal(open.length, 0);
  const all = listConstraints(p.id, 'all', 10);
  assert.equal(all.find((c) => c.text === '这条已经过期')?.status, 'resolved');
});

test('千章一致性检查会抽样早期章节，而不是只看最后 40 章', () => {
  const chapters = Array.from({ length: 300 }, (_, i) => ({
    id: `c${i}`,
    projectId: 'p',
    volumeId: null,
    title: `第${i + 1}章`,
    order: i,
    outline: `大纲 ${i}`,
    content: i === 299 ? '最后一章正文' : '',
    status: 'done',
    wordCount: 0,
    summary: `摘要 ${i}`,
    createdAt: '',
    updatedAt: '',
  })) as Chapter[];

  const sample = sampleChaptersForCheck(chapters);
  assert.ok(sample.selected.length < chapters.length, '不应该把 300 章全塞进上下文');
  assert.ok(sample.selected.some((c) => c.order === 0), '应包含开篇第 1 章');
  assert.ok(sample.selected.some((c) => c.order === 299), '应包含最后一章');
  assert.ok(sample.selected.length >= 40, '抽样也要够覆盖全书');

  const prompt = buildConsistencyPrompt({
    project: { id: 'p', title: '千章', logline: '', genre: '', styleGuide: '', targetWords: 0, status: 'drafting', createdAt: '', updatedAt: '' } as Project,
    entities: [],
    chapters,
    foreshadows: [],
    timeline: [],
  });
  assert.match(prompt.user, /全书抽样/);
  assert.match(prompt.user, /第1章/);
});

test('事实核查单的引用片段会落库并随章节读回', () => {
  const p = createProject({ title: '引用落库' });
  const c = createChapter(p.id, { title: '第一章' });
  setChapterFacts(
    c.id,
    [{ point: '京畿府名', query: '顺天府', mustHave: true }],
    {
      hits: [{ forPoints: ['京畿府名'], docTitle: '制度备忘', source: '史实.md', text: '明代设顺天府。' }],
      generatedAt: '2026-01-01T00:00:00.000Z',
    },
  );
  const loaded = getChapter(c.id)!;
  assert.equal(loaded.factSheet?.hits.length, 1);
  assert.equal(loaded.factSheet?.hits[0]?.docTitle, '制度备忘');
  assert.equal(loaded.factSheet?.generatedAt, '2026-01-01T00:00:00.000Z');
});

test('重叠分块：相邻片段共享尾部，跨边界事实不会丢', () => {
  const para1 = '甲'.repeat(80);
  const para2 = '乙'.repeat(80);
  const chunks = chunkText(`${para1}\n\n${para2}`, 100, 20);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks[1]!.startsWith(chunks[0]!.slice(-20)), '下一段应以上一段尾部开头');
});

test('知识库倒排索引随文档创建/删除同步', () => {
  const p = createProject({ title: '倒排索引' });
  const doc = createDoc(p.id, { title: '资料', content: '明代京畿设顺天府，不称京兆府。' });
  const terms = getDb()
    .prepare('SELECT COUNT(*) AS n FROM knowledge_terms WHERE project_id = ?')
    .get(p.id) as { n: number };
  assert.ok(terms.n > 0, '应写入倒排词');

  const hit = searchKnowledge(p.id, '顺天府', 3);
  assert.ok(hit.length > 0, '应能通过索引召回');

  deleteDoc(doc.id);
  const after = getDb()
    .prepare('SELECT COUNT(*) AS n FROM knowledge_terms WHERE project_id = ?')
    .get(p.id) as { n: number };
  assert.equal(after.n, 0, '删除资料后倒排词也应清空');
});


test('旧资料缺少倒排索引时，启动重建能补齐', () => {
  const p = createProject({ title: '索引重建' });
  const doc = createDoc(p.id, { title: '旧资料', content: '明代京畿设顺天府，不称京兆府。' });

  // 模拟 v9 之前的数据：有片段、没有倒排词、没有版本标记
  getDb().prepare('DELETE FROM knowledge_terms WHERE project_id = ?').run(p.id);
  getDb().prepare("DELETE FROM settings WHERE key = 'knowledge_index_version'").run();

  reindexKnowledgeIfNeeded();

  const terms = getDb()
    .prepare('SELECT COUNT(*) AS n FROM knowledge_terms WHERE project_id = ?')
    .get(p.id) as { n: number };
  assert.ok(terms.n > 0, '重建后应有倒排词');
  const chunks = getDb()
    .prepare('SELECT COUNT(*) AS n FROM knowledge_chunks WHERE doc_id = ?')
    .get(doc.id) as { n: number };
  assert.ok(chunks.n > 0, '片段应保留/重建');
  assert.ok(searchKnowledge(p.id, '顺天府', 3).length > 0);
});
