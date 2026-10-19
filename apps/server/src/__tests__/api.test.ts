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

describe('设置', () => {
  test('读取时对 API Key 打码', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: {
        text: {
          baseUrl: 'https://api.deepseek.com/v1',
          apiKey: 'sk-abcdefghijklmnop',
          model: 'deepseek-chat',
        },
      },
    });
    const res = await get('/api/settings');
    const s = JSON.parse(res.body);
    assert.equal(s.hasTextKey, true);
    assert.notEqual(s.text.apiKey, 'sk-abcdefghijklmnop');
    assert.ok(s.text.apiKey.includes('••••'));
  });

  test('回传打码值不会覆盖真实 Key', async () => {
    const before = JSON.parse((await get('/api/settings')).body);
    await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: {
        text: {
          baseUrl: before.text.baseUrl,
          apiKey: before.text.apiKey,
          model: 'deepseek-reasoner',
        },
      },
    });
    const after = JSON.parse((await get('/api/settings')).body);
    assert.equal(after.hasTextKey, true);
    assert.equal(after.text.model, 'deepseek-reasoner');
  });
});

describe('未配置模型时的写作接口', () => {
  test('显式清空 API Key 后写作返回 412', async () => {
    // 空串表示用户主动清空
    await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { text: { baseUrl: '', apiKey: '', model: '' } },
    });
    const s = JSON.parse((await get('/api/settings')).body);
    assert.equal(s.hasTextKey, false, 'Key 应已被清空');

    const p = JSON.parse((await post('/api/projects', { title: '未配置' })).body);
    const c = JSON.parse((await post(`/api/projects/${p.id}/chapters`, { title: 'c' })).body);
    const res = await post('/api/write/stream', {
      projectId: p.id,
      chapterId: c.id,
      mode: 'continue',
    });
    assert.equal(res.statusCode, 412);
  });
});
