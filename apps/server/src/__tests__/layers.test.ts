import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Chapter, Project } from '@novelforge/shared';
import { buildBeatsPrompt, buildScenesPrompt, parseSceneCards, scenesToText } from '../ai/layers.js';
import { chunkText } from '../repos/layers.repo.js';

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

const chapter = {
  id: 'c1',
  projectId: 'p1',
  volumeId: null,
  title: '第一章 · 雪落祠堂',
  order: 0,
  outline: '林尘被逐出家门',
  beats: '',
  content: '',
  status: 'outline',
  wordCount: 0,
  summary: '',
  createdAt: '',
  updatedAt: '',
} as Chapter;

test('buildBeatsPrompt 带上书名、大纲与前情', () => {
  const p = buildBeatsPrompt(project, chapter, ['序章：家族败落']);
  assert.match(p.system, /雪落长夜/);
  assert.match(p.user, /林尘被逐出家门/);
  assert.match(p.system, /序章：家族败落/);
  assert.match(p.system, /钩子/);
});

test('buildScenesPrompt 要求目标-阻力-结果', () => {
  const p = buildScenesPrompt({ ...project, genre: '玄幻' } as Project, chapter);
  assert.match(p.system, /目标/);
  assert.match(p.system, /阻力/);
  assert.match(p.system, /JSON/);
});

test('parseSceneCards 解析正常 JSON', () => {
  const raw = JSON.stringify({
    scenes: [
      {
        title: '祠堂除名',
        pov: '林尘',
        location: '祠堂',
        goal: '保住族籍',
        conflict: '家主已定罪',
        outcome: '被逐出',
        keyLines: '「念你年幼，不予追究。」',
      },
    ],
  });
  const list = parseSceneCards(raw);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.title, '祠堂除名');
  assert.equal(list[0]!.location, '祠堂');
});

test('parseSceneCards 去掉代码块', () => {
  const raw = '```json\n{"scenes":[{"title":"A"}]}\n```';
  assert.equal(parseSceneCards(raw).length, 1);
});

test('parseSceneCards 对非法结构报错', () => {
  assert.throws(() => parseSceneCards('我写不出来'), /没有返回可解析/);
  assert.throws(() => parseSceneCards('{"scenes":[]}'), /没有给出场景卡/);
});

test('parseSceneCards 最多 8 个场景', () => {
  const raw = JSON.stringify({
    scenes: Array.from({ length: 20 }, (_, i) => ({ title: `S${i}` })),
  });
  assert.equal(parseSceneCards(raw).length, 8);
});

test('scenesToText 拼出场景说明', () => {
  const text = scenesToText([
    {
      id: 's1',
      projectId: 'p1',
      chapterId: 'c1',
      order: 0,
      title: '雪夜',
      pov: '林尘',
      location: '外院',
      goal: '活下去',
      conflict: '冻伤',
      outcome: '遇见苏晚',
      keyLines: '「路过。」',
      createdAt: '',
      updatedAt: '',
    },
  ]);
  assert.match(text, /雪夜/);
  assert.match(text, /视角：林尘/);
  assert.match(text, /目标：活下去/);
  assert.match(text, /关键台词/);
});

test('chunkText 按段落切分并控制长度', () => {
  const para = '这是一段设定文字。'.repeat(10);
  const content = [para, para, para].join('\n\n');
  const chunks = chunkText(content, 200);
  assert.ok(chunks.length >= 2, `实际 ${chunks.length} 段`);
  for (const c of chunks) {
    assert.ok(c.length <= 400, `片段过长: ${c.length}`);
  }
});

test('chunkText 对空内容也有兜底', () => {
  const chunks = chunkText('');
  assert.ok(chunks.length >= 1);
});
