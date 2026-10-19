import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

/**
 * API 集成测试：用临时数据目录启动真实 Fastify 实例，走真实 inject。
 * 覆盖 CRUD、字数统计、导出、设置掩码等关键路径。
 */
let app: FastifyInstance;
let dataDir: string;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novelforge-test-'));
  process.env.NOVELFORGE_DATA_DIR = dataDir;
  const { buildServer } = await import('../index.js');
  app = await buildServer();
  await app.ready();
});

after(async () => {
  await app?.close();
  // Windows 上 SQLite 的 WAL 文件可能短暂占用目录，重试几次再放弃
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 120));
    }
  }
});

const post = (url: string, payload?: unknown) =>
  app.inject({ method: 'POST', url, payload: payload as object });
const patch = (url: string, payload: unknown) =>
  app.inject({ method: 'PATCH', url, payload: payload as object });
const get = (url: string) => app.inject({ method: 'GET', url });
const del = (url: string) => app.inject({ method: 'DELETE', url });

describe('健康检查', () => {
  test('返回 ok', async () => {
    const res = await get('/api/health');
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).ok, true);
  });
});

describe('项目 CRUD', () => {
  let id = '';

  test('创建项目', async () => {
    const res = await post('/api/projects', { title: '测试书', genre: '玄幻' });
    assert.equal(res.statusCode, 201);
    const p = JSON.parse(res.body);
    assert.equal(p.title, '测试书');
    assert.ok(p.id);
    id = p.id;
  });

  test('拒绝空标题', async () => {
    const res = await post('/api/projects', { title: '' });
    assert.equal(res.statusCode, 400);
  });

  test('列出项目', async () => {
    const res = await get('/api/projects');
    assert.equal(res.statusCode, 200);
    assert.ok(JSON.parse(res.body).some((p: { id: string }) => p.id === id));
  });

  test('读取单个项目', async () => {
    const res = await get(`/api/projects/${id}`);
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).title, '测试书');
  });

  test('更新项目', async () => {
    const res = await patch(`/api/projects/${id}`, { title: '改名了' });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).title, '改名了');
  });

  test('不存在的项目返回 404', async () => {
    const res = await get('/api/projects/does-not-exist');
    assert.equal(res.statusCode, 404);
  });
});

describe('作品库概览', () => {
  test('返回统计字段且新作品计数为 0', async () => {
    const created = JSON.parse((await post('/api/projects', { title: '概览测试' })).body);
    const res = await get('/api/projects/overview');
    assert.equal(res.statusCode, 200);
    const list = JSON.parse(res.body) as {
      id: string;
      title: string;
      chapterCount: number;
      wordCount: number;
      entityCount: number;
      coverUrl: string | null;
    }[];
    const item = list.find((p) => p.id === created.id);
    assert.ok(item, '新作品应出现在概览中');
    assert.equal(item.chapterCount, 0);
    assert.equal(item.wordCount, 0);
    assert.equal(item.entityCount, 0);
    assert.equal(item.coverUrl, null);
  });

  test('统计随章节与设定更新', async () => {
    const p = JSON.parse((await post('/api/projects', { title: '统计测试' })).body);
    const c = JSON.parse((await post(`/api/projects/${p.id}/chapters`, { title: '第一章' })).body);
    await patch(`/api/chapters/${c.id}`, { content: '雪落了三日' });
    await post(`/api/projects/${p.id}/entities`, { type: 'character', name: '甲' });

    const list = JSON.parse((await get('/api/projects/overview')).body) as {
      id: string;
      chapterCount: number;
      wordCount: number;
      entityCount: number;
    }[];
    const item = list.find((x) => x.id === p.id)!;
    assert.equal(item.chapterCount, 1);
    assert.equal(item.wordCount, 5);
    assert.equal(item.entityCount, 1);
  });

  test('概览按更新时间倒序，最新在前', async () => {
    const list = JSON.parse((await get('/api/projects/overview')).body) as {
      updatedAt: string;
    }[];
    for (let i = 1; i < list.length; i++) {
      assert.ok(
        list[i - 1]!.updatedAt >= list[i]!.updatedAt,
        '概览结果应按 updatedAt 倒序',
      );
    }
  });
});

describe('设定库', () => {
  let projectId = '';
  let entityId = '';

  before(async () => {
    const res = await post('/api/projects', { title: '设定测试' });
    projectId = JSON.parse(res.body).id;
  });

  test('创建带别名与字段的设定', async () => {
    const res = await post(`/api/projects/${projectId}/entities`, {
      type: 'character',
      name: '林尘',
      aliases: ['尘弟'],
      summary: '主角',
      fields: [{ key: '年龄', value: '17' }],
      pinned: true,
    });
    assert.equal(res.statusCode, 201);
    const e = JSON.parse(res.body);
    assert.equal(e.name, '林尘');
    assert.deepEqual(e.aliases, ['尘弟']);
    assert.equal(e.fields[0].key, '年龄');
    assert.equal(e.pinned, true);
    entityId = e.id;
  });

  test('按类型过滤', async () => {
    const res = await get(`/api/projects/${projectId}/entities?type=character`);
    assert.equal(JSON.parse(res.body).length, 1);
    const none = await get(`/api/projects/${projectId}/entities?type=faction`);
    assert.equal(JSON.parse(none.body).length, 0);
  });

  test('切换固定状态', async () => {
    const res = await patch(`/api/entities/${entityId}`, { pinned: false });
    assert.equal(JSON.parse(res.body).pinned, false);
  });

  test('拒绝非法类型', async () => {
    const res = await post(`/api/projects/${projectId}/entities`, {
      type: 'spaceship',
      name: 'x',
    });
    assert.equal(res.statusCode, 400);
  });

  test('删除设定', async () => {
    const res = await del(`/api/entities/${entityId}`);
    assert.equal(res.statusCode, 200);
    const after = await get(`/api/entities/${entityId}`);
    assert.equal(after.statusCode, 404);
  });
});

describe('卷与章节', () => {
  let projectId = '';
  let volumeId = '';
  let chapterId = '';

  before(async () => {
    const res = await post('/api/projects', { title: '章节测试' });
    projectId = JSON.parse(res.body).id;
  });

  test('创建卷', async () => {
    const res = await post(`/api/projects/${projectId}/volumes`, { title: '第一卷' });
    assert.equal(res.statusCode, 201);
    volumeId = JSON.parse(res.body).id;
  });

  test('在卷下创建章节', async () => {
    const res = await post(`/api/projects/${projectId}/chapters`, {
      title: '第一章',
      volumeId,
      outline: '开端',
    });
    assert.equal(res.statusCode, 201);
    const c = JSON.parse(res.body);
    assert.equal(c.title, '第一章');
    assert.equal(c.volumeId, volumeId);
    chapterId = c.id;
  });

  test('更新正文并重算字数', async () => {
    const res = await patch(`/api/chapters/${chapterId}`, { content: '雪落了三日' });
    assert.equal(res.statusCode, 200);
    const c = JSON.parse(res.body);
    assert.equal(c.content, '雪落了三日');
    assert.equal(c.wordCount, 5);
  });

  test('有正文后状态自动转为 drafting', async () => {
    const res = await post(`/api/chapters/${chapterId}/apply`, { text: '追加内容' });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).status, 'drafting');
  });

  test('项目统计正确', async () => {
    const res = await get(`/api/projects/${projectId}/stats`);
    const s = JSON.parse(res.body);
    assert.equal(s.chapterCount, 1);
    assert.equal(s.volumeCount, 1);
    assert.ok(s.totalWords > 0);
  });

  test('拒绝非法章节状态', async () => {
    const res = await post(`/api/projects/${projectId}/chapters`, {
      title: 'x',
      status: 'bogus',
    });
    assert.equal(res.statusCode, 400);
  });

  test('章节排序接口可用', async () => {
    const c2 = JSON.parse(
      (await post(`/api/projects/${projectId}/chapters`, { title: '第二章' })).body,
    );
    const res = await post(`/api/projects/${projectId}/chapters/reorder`, {
      order: [c2.id, chapterId],
    });
    assert.equal(res.statusCode, 200);
    const list = JSON.parse((await get(`/api/projects/${projectId}/chapters`)).body);
    assert.equal(list[0].id, c2.id);
  });
});

describe('导出', () => {
  let projectId = '';

  before(async () => {
    const res = await post('/api/projects', { title: '导出测试' });
    projectId = JSON.parse(res.body).id;
    const ch = await post(`/api/projects/${projectId}/chapters`, { title: '第一章' });
    const cid = JSON.parse(ch.body).id;
    await patch(`/api/chapters/${cid}`, { content: '正文内容', outline: '大纲内容' });
  });

  test('导出 TXT', async () => {
    const res = await post(`/api/projects/${projectId}/export`, { format: 'txt' });
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes('第一章'));
    assert.ok(res.body.includes('正文内容'));
  });

  test('导出 Markdown 并含大纲', async () => {
    const res = await post(`/api/projects/${projectId}/export`, {
      format: 'md',
      includeOutline: true,
    });
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes('# 导出测试'));
    assert.ok(res.body.includes('大纲内容'));
  });

  test('导出 DOCX 返回二进制', async () => {
    const res = await post(`/api/projects/${projectId}/export`, { format: 'docx' });
    assert.equal(res.statusCode, 200);
    assert.match(
      String(res.headers['content-type']),
      /wordprocessingml\.document/,
    );
    assert.ok(res.rawPayload.length > 1000);
  });

  test('拒绝未知格式', async () => {
    const res = await post(`/api/projects/${projectId}/export`, { format: 'pdf' });
    assert.equal(res.statusCode, 400);
  });
});

describe('AI 生成小说', () => {
  const draft = {
    title: '雪落长夜',
    logline: '少年剑修追查父亲冤案。',
    genre: '古典玄幻',
    styleGuide: '冷峻克制',
    entities: [
      { type: 'character', name: '沈砚', summary: '主角', pinned: true },
      { type: 'faction', name: '青云宗', summary: '剑宗', pinned: false },
    ],
    volumes: [
      { title: '第一卷', summary: '开端' },
      { title: '第二卷', summary: '发展' },
    ],
    chapters: [
      { volumeIndex: 0, title: '第一章', outline: '开局' },
      { volumeIndex: 1, title: '第二章', outline: '转折' },
    ],
  };

  test('未配置模型时生成方案返回 412', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { text: { baseUrl: '', apiKey: '', model: '' } },
    });
    const res = await post('/api/ai/draft', { idea: '写一个剑修复仇的故事' });
    assert.equal(res.statusCode, 412);
  });

  test('需求太短返回 400', async () => {
    const res = await post('/api/ai/draft', { idea: '剑' });
    assert.equal(res.statusCode, 400);
  });

  test('按方案创建作品，卷章映射正确', async () => {
    const res = await post('/api/projects/from-draft', { draft });
    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.body) as {
      project: { id: string; title: string };
      counts: { entities: number; volumes: number; chapters: number };
    };
    assert.equal(body.project.title, '雪落长夜');
    assert.equal(body.counts.entities, 2);
    assert.equal(body.counts.volumes, 2);
    assert.equal(body.counts.chapters, 2);

    const volumes = JSON.parse((await get(`/api/projects/${body.project.id}/volumes`)).body) as {
      id: string;
      title: string;
    }[];
    const chapters = JSON.parse(
      (await get(`/api/projects/${body.project.id}/chapters`)).body,
    ) as { title: string; volumeId: string | null }[];
    assert.equal(chapters.length, 2);
    // 第一章应挂在第一卷下，第二章挂在第二卷下
    assert.equal(chapters[0]!.volumeId, volumes[0]!.id);
    assert.equal(chapters[1]!.volumeId, volumes[1]!.id);

    const entities = JSON.parse(
      (await get(`/api/projects/${body.project.id}/entities`)).body,
    ) as { name: string; pinned: boolean }[];
    assert.equal(entities.length, 2);
    assert.equal(entities.find((e) => e.name === '沈砚')!.pinned, true);
  });

  test('创建的作品出现在书架概览里', async () => {
    const created = JSON.parse((await post('/api/projects/from-draft', { draft })).body);
    const list = JSON.parse((await get('/api/projects/overview')).body) as {
      id: string;
      chapterCount: number;
      entityCount: number;
    }[];
    const item = list.find((p) => p.id === created.project.id)!;
    assert.equal(item.chapterCount, 2);
    assert.equal(item.entityCount, 2);
  });

  test('方案缺少章节时拒绝创建', async () => {
    const res = await post('/api/projects/from-draft', {
      draft: { ...draft, chapters: [] },
    });
    assert.equal(res.statusCode, 400);
  });

  test('方案缺少书名时拒绝创建', async () => {
    const res = await post('/api/projects/from-draft', {
      draft: { ...draft, title: '' },
    });
    assert.equal(res.statusCode, 400);
  });
});

describe('模型配置（多套）', () => {
  test('首次读取会自动带出一个可填的默认配置', async () => {
    const s = JSON.parse((await get('/api/settings')).body);
    assert.ok(Array.isArray(s.profiles));
    assert.ok(s.profiles.length >= 1, '至少有一个默认配置');
    assert.ok(s.activeProfileId, '应自动选择一个当前配置');
  });

  test('新增配置，Key 打码返回', async () => {
    const res = await post('/api/profiles', {
      name: 'DeepSeek 官方',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-abcdefghijklmnop',
      model: 'deepseek-chat',
    });
    assert.equal(res.statusCode, 201);
    const p = JSON.parse(res.body);
    assert.equal(p.name, 'DeepSeek 官方');
    assert.equal(p.hasApiKey, true);
    assert.ok(!('apiKey' in p), '不应把真实 Key 返回给前端');
    assert.ok(p.apiKeyMasked.includes('••••'));
  });

  test('可以存多套并切换当前配置', async () => {
    const a = JSON.parse(
      (
        await post('/api/profiles', {
          name: '配置 A',
          baseUrl: 'https://a.example.com/v1',
          apiKey: 'sk-aaaa1111',
          model: 'model-a',
        })
      ).body,
    );
    const b = JSON.parse(
      (
        await post('/api/profiles', {
          name: '配置 B',
          baseUrl: 'https://b.example.com/v1',
          apiKey: 'sk-bbbb2222',
          model: 'model-b',
        })
      ).body,
    );

    await post(`/api/profiles/${b.id}/activate`);
    let s = JSON.parse((await get('/api/settings')).body);
    assert.equal(s.activeProfileId, b.id);

    await post(`/api/profiles/${a.id}/activate`);
    s = JSON.parse((await get('/api/settings')).body);
    assert.equal(s.activeProfileId, a.id);
    assert.equal(s.profiles.length >= 2, true);
  });

  test('编辑配置时回传打码值不会覆盖真实 Key', async () => {
    const created = JSON.parse(
      (
        await post('/api/profiles', {
          name: '保留 Key 测试',
          baseUrl: 'https://x.example.com/v1',
          apiKey: 'sk-real-key-value',
          model: 'm1',
        })
      ).body,
    );
    const patched = await patch(`/api/profiles/${created.id}`, {
      name: '改了名字',
      apiKey: created.apiKeyMasked, // 前端回显的掩码
      model: 'm2',
    });
    assert.equal(patched.statusCode, 200);
    const after = JSON.parse(patched.body);
    assert.equal(after.name, '改了名字');
    assert.equal(after.model, 'm2');
    assert.equal(after.hasApiKey, true, 'Key 应仍然保留');
  });

  test('显式传空串可以清空 Key', async () => {
    const created = JSON.parse(
      (
        await post('/api/profiles', {
          name: '清空 Key 测试',
          baseUrl: 'https://y.example.com/v1',
          apiKey: 'sk-to-be-cleared',
          model: 'm1',
        })
      ).body,
    );
    const after = JSON.parse(
      (await patch(`/api/profiles/${created.id}`, { apiKey: '' })).body,
    );
    assert.equal(after.hasApiKey, false);
  });

  test('删除当前配置后自动切换到下一个', async () => {
    const p1 = JSON.parse(
      (await post('/api/profiles', { name: '待删1', baseUrl: 'https://1.example.com', apiKey: 'k1', model: 'm' })).body,
    );
    const p2 = JSON.parse(
      (await post('/api/profiles', { name: '待删2', baseUrl: 'https://2.example.com', apiKey: 'k2', model: 'm' })).body,
    );
    await post(`/api/profiles/${p2.id}/activate`);

    const res = await del(`/api/profiles/${p2.id}`);
    assert.equal(res.statusCode, 200);
    const s = JSON.parse((await get('/api/settings')).body);
    assert.ok(s.activeProfileId, '删除后仍应有一个当前配置');
    assert.notEqual(s.activeProfileId, p2.id);
    assert.ok(s.profiles.some((x: { id: string }) => x.id === p1.id));
  });

  test('缺少必填字段时拒绝新增', async () => {
    const res = await post('/api/profiles', { name: '', baseUrl: 'x', model: 'y' });
    assert.equal(res.statusCode, 400);
  });
});

describe('AI 生成目录（已有作品）', () => {
  let projectId = '';

  before(async () => {
    const p = JSON.parse((await post('/api/projects', { title: '目录测试' })).body);
    projectId = p.id;
  });

  test('未配置模型时生成目录返回 412', async () => {
    const p = JSON.parse(
      (
        await post('/api/profiles', {
          name: '目录无 Key',
          baseUrl: 'https://nokey.example.com/v1',
          apiKey: '',
          model: 'm',
        })
      ).body,
    );
    await post(`/api/profiles/${p.id}/activate`);
    const res = await post(`/api/projects/${projectId}/generate-toc`, { chapterCount: 10 });
    assert.equal(res.statusCode, 412);
  });

  test('把目录写入作品：卷章按 volumeIndex 正确归属', async () => {
    const res = await post(`/api/projects/${projectId}/apply-toc`, {
      volumes: [
        { title: '第一卷 · 开端', summary: '起步' },
        { title: '第二卷 · 转折', summary: '发展' },
      ],
      chapters: [
        { volumeIndex: 0, title: '第1章 · 雪夜', outline: '开端' },
        { volumeIndex: 1, title: '第2章 · 归来', outline: '转折' },
      ],
    });
    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.body) as { counts: { volumes: number; chapters: number } };
    assert.equal(body.counts.volumes, 2);
    assert.equal(body.counts.chapters, 2);

    const volumes = JSON.parse((await get(`/api/projects/${projectId}/volumes`)).body) as {
      id: string;
      title: string;
    }[];
    const chapters = JSON.parse((await get(`/api/projects/${projectId}/chapters`)).body) as {
      title: string;
      volumeId: string | null;
    }[];
    assert.equal(chapters.length, 2);
    assert.equal(chapters[0]!.volumeId, volumes[0]!.id);
    assert.equal(chapters[1]!.volumeId, volumes[1]!.id);
  });

  test('再次写入是追加，不覆盖已有章节', async () => {
    const res = await post(`/api/projects/${projectId}/apply-toc`, {
      chapters: [{ volumeIndex: 0, title: '第3章 · 追加', outline: '' }],
    });
    assert.equal(res.statusCode, 201);
    const chapters = JSON.parse((await get(`/api/projects/${projectId}/chapters`)).body);
    assert.equal(chapters.length, 3);
  });

  test('目录缺章节时拒绝写入', async () => {
    const res = await post(`/api/projects/${projectId}/apply-toc`, { chapters: [] });
    assert.equal(res.statusCode, 400);
  });
});

describe('分层创作与知识库', () => {
  let projectId = '';
  let chapterId = '';

  before(async () => {
    const p = JSON.parse((await post('/api/projects', { title: '分层测试' })).body);
    projectId = p.id;
    const c = JSON.parse(
      (await post(`/api/projects/${projectId}/chapters`, { title: '第一章' })).body,
    );
    chapterId = c.id;
  });

  test('脑暴板可保存', async () => {
    const res = await patch(`/api/projects/${projectId}`, { brainstorm: '- 主角的剑是他父亲的脊椎' });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).brainstorm, '- 主角的剑是他父亲的脊椎');
  });

  test('细纲可保存并读回', async () => {
    const res = await patch(`/api/chapters/${chapterId}`, { beats: '1. 祠堂除名 → 林尘被逐出' });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).beats, '1. 祠堂除名 → 林尘被逐出');
    const got = JSON.parse((await get(`/api/chapters/${chapterId}`)).body);
    assert.match(got.beats, /祠堂除名/);
  });

  test('场景卡可增删改查', async () => {
    const created = await post(`/api/chapters/${chapterId}/scenes`, {
      title: '祠堂除名',
      pov: '林尘',
      goal: '保住族籍',
      conflict: '家主定罪',
      outcome: '被逐出',
    });
    assert.equal(created.statusCode, 201);
    const scene = JSON.parse(created.body);
    assert.equal(scene.title, '祠堂除名');

    const list = JSON.parse((await get(`/api/chapters/${chapterId}/scenes`)).body);
    assert.equal(list.length, 1);

    const updated = await patch(`/api/scenes/${scene.id}`, { outcome: '被逐出并失去族籍' });
    assert.equal(updated.statusCode, 200);
    assert.match(JSON.parse(updated.body).outcome, /失去族籍/);

    const removed = await del(`/api/scenes/${scene.id}`);
    assert.equal(removed.statusCode, 200);
    assert.equal(JSON.parse((await get(`/api/chapters/${chapterId}/scenes`)).body).length, 0);
  });

  test('知识库可上传并检索到片段', async () => {
    const created = await post(`/api/projects/${projectId}/knowledge`, {
      title: '世界观设定集',
      source: '作者笔记.md',
      content:
        '北域常年积雪，冬季长达半年。修行界以「境」分层次：引气、凝脉、铸骨、通神、化虚。\n\n北境有一座塔，塔中封着上一代的剑意。',
    });
    assert.equal(created.statusCode, 201);
    const doc = JSON.parse(created.body);
    assert.ok(doc.chunkCount >= 1);

    const search = JSON.parse(
      (await get(`/api/projects/${projectId}/knowledge/search?q=${encodeURIComponent('北境 塔')}`))
        .body,
    );
    assert.ok(search.hits.length >= 1, '应检索到片段');
    assert.match(search.hits[0].text, /塔|北境/);
    assert.equal(search.hits[0].source, '作者笔记.md');

    const list = JSON.parse((await get(`/api/projects/${projectId}/knowledge`)).body);
    assert.equal(list.length, 1);

    const removed = await del(`/api/knowledge/${doc.id}`);
    assert.equal(removed.statusCode, 200);
  });

  test('未配置模型时生成细纲返回 412', async () => {
    const p = JSON.parse(
      (
        await post('/api/profiles', {
          name: '分层无 Key',
          baseUrl: 'https://nokey.example.com/v1',
          apiKey: '',
          model: 'm',
        })
      ).body,
    );
    await post(`/api/profiles/${p.id}/activate`);
    const res = await post('/api/ai/chapter-beats', { projectId, chapterId });
    assert.equal(res.statusCode, 412);
    const res2 = await post('/api/ai/scene-cards', { projectId, chapterId });
    assert.equal(res2.statusCode, 412);
  });
});

describe('一致性引擎（伏笔 / 时间线 / 检查）', () => {
  let projectId = '';

  before(async () => {
    const res = await post('/api/projects', { title: '一致性测试' });
    projectId = JSON.parse(res.body).id;
  });

  test('新增伏笔并列出', async () => {
    const res = await post(`/api/projects/${projectId}/foreshadows`, {
      title: '北境的塔',
      detail: '父亲临终前提过',
      importance: 3,
    });
    assert.equal(res.statusCode, 201);
    const f = JSON.parse(res.body);
    assert.equal(f.title, '北境的塔');
    assert.equal(f.status, 'planted');

    const list = JSON.parse((await get(`/api/projects/${projectId}/foreshadows`)).body);
    assert.equal(list.length, 1);
  });

  test('把伏笔标记为已回收', async () => {
    const list = JSON.parse((await get(`/api/projects/${projectId}/foreshadows`)).body);
    const res = await patch(`/api/foreshadows/${list[0].id}`, { status: 'recovered' });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).status, 'recovered');
  });

  test('拒绝空标题的伏笔', async () => {
    const res = await post(`/api/projects/${projectId}/foreshadows`, { title: '' });
    assert.equal(res.statusCode, 400);
  });

  test('新增与删除时间线事件', async () => {
    const res = await post(`/api/projects/${projectId}/timeline`, {
      storyTime: '第三年·冬',
      title: '试剑夺魁',
    });
    assert.equal(res.statusCode, 201);
    const ev = JSON.parse(res.body);
    assert.equal(ev.storyTime, '第三年·冬');

    const removed = await del(`/api/timeline/${ev.id}`);
    assert.equal(removed.statusCode, 200);
    const list = JSON.parse((await get(`/api/projects/${projectId}/timeline`)).body);
    assert.equal(list.length, 0);
  });

  test('不存在的作品返回 404', async () => {
    const res = await get('/api/projects/does-not-exist/foreshadows');
    assert.equal(res.statusCode, 404);
  });

  test('未配置模型时一致性检查返回 412', async () => {
    // 造一个没有 Key 的配置并设为当前
    const p = JSON.parse(
      (
        await post('/api/profiles', {
          name: '检查用无 Key',
          baseUrl: 'https://nokey.example.com/v1',
          apiKey: '',
          model: 'm',
        })
      ).body,
    );
    await post(`/api/profiles/${p.id}/activate`);
    const res = await post(`/api/projects/${projectId}/consistency-check`);
    assert.equal(res.statusCode, 412);
  });
});

describe('DSH 一键导入', () => {
  let realHome: string | undefined;

  before(() => {
    realHome = process.env.DSH_HOME;
    const dir = path.join(dataDir, 'fake-dsh');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.credentials.yaml'),
      [
        'records:',
        '  deepseek-account-platform/default:',
        '    kind: grant',
        '    payload:',
        '      version: 1',
        '      token: abc',
        'refs:',
        '  DEEPSEEK_API_KEY: sk-test-dsh-key-1234567890',
      ].join('\n'),
      'utf8',
    );
    process.env.DSH_HOME = dir;
  });

  after(() => {
    if (realHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = realHome;
  });

  test('能探测到 DSH 凭据并只回打码值', async () => {
    const res = await get('/api/dsh/status');
    assert.equal(res.statusCode, 200);
    const s = JSON.parse(res.body) as {
      available: boolean;
      keys: { name: string; masked: string }[];
      recommended: string | null;
      hasAccountToken: boolean;
    };
    assert.equal(s.available, true);
    assert.equal(s.recommended, 'DEEPSEEK_API_KEY');
    assert.ok(s.keys[0]!.masked.includes('••••'));
    assert.ok(!s.keys[0]!.masked.includes('1234567890'), '不能泄露完整 Key');
    assert.equal(s.hasAccountToken, true);
  });

  test('导入后生成配置并设为当前', async () => {
    const res = await post('/api/dsh/import', {});
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as {
      profile: { id: string; name: string; baseUrl: string; model: string };
      sourceKey: string;
    };
    assert.equal(body.profile.name, 'DeepSeek（DSH 内置）');
    assert.match(body.profile.baseUrl, /api\.deepseek\.com/);
    assert.equal(body.sourceKey, 'DEEPSEEK_API_KEY');

    const s = JSON.parse((await get('/api/settings')).body) as {
      activeProfileId: string;
      profiles: { id: string; hasApiKey: boolean }[];
    };
    assert.equal(s.activeProfileId, body.profile.id);
    assert.equal(s.profiles.find((p) => p.id === body.profile.id)!.hasApiKey, true);
  });

  test('重复导入不会创建重复配置', async () => {
    const before = JSON.parse((await get('/api/settings')).body).profiles.length;
    const res = await post('/api/dsh/import', {});
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).reused, true);
    const after = JSON.parse((await get('/api/settings')).body).profiles.length;
    assert.equal(after, before);
  });

  test('找不到凭据时返回 404', async () => {
    const empty = path.join(dataDir, 'empty-dsh');
    fs.mkdirSync(empty, { recursive: true });
    process.env.DSH_HOME = empty;
    const res = await post('/api/dsh/import', {});
    assert.equal(res.statusCode, 404);
  });
});

describe('未配置模型时的写作接口', () => {
  test('当前配置没有 Key 时写作返回 412', async () => {
    // 造一个没有 Key 的配置并设为当前
    const p = JSON.parse(
      (
        await post('/api/profiles', {
          name: '无 Key 配置',
          baseUrl: 'https://nokey.example.com/v1',
          apiKey: '',
          model: 'm',
        })
      ).body,
    );
    await post(`/api/profiles/${p.id}/activate`);

    const s = JSON.parse((await get('/api/settings')).body);
    const active = s.profiles.find((x: { id: string }) => x.id === s.activeProfileId);
    assert.equal(active.hasApiKey, false);

    const proj = JSON.parse((await post('/api/projects', { title: '未配置' })).body);
    const ch = JSON.parse(
      (await post(`/api/projects/${proj.id}/chapters`, { title: 'c' })).body,
    );
    const res = await post('/api/write/stream', {
      projectId: proj.id,
      chapterId: ch.id,
      mode: 'continue',
    });
    assert.equal(res.statusCode, 412);
  });
});
