import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Chapter, FactPoint, Project } from '@novelforge/shared';
import { buildSelfFixPrompt, parseSelfFix } from '../ai/facts.js';

const project = {
  id: 'p1',
  title: '孤的肥皂',
  logline: '少年穿成冷院皇子，靠肥皂翻身',
  genre: '历史',
  styleGuide: '第一人称限知',
  rules: '皇子份例由内务府供给，不存在向皇子收冬衣钱。',
  targetWords: 0,
  status: 'drafting',
  createdAt: '',
  updatedAt: '',
} as Project;

const chapter = {
  id: 'c1',
  projectId: 'p1',
  volumeId: null,
  title: '第1章 · 冷院醒来',
  order: 0,
  outline: '太监上门收六两冬衣钱，我掏不起',
  beats: '1. 【冷院】冻醒',
  content: '',
  status: 'outline',
  wordCount: 0,
  summary: '',
  createdAt: '',
  updatedAt: '',
} as Chapter;

const points: FactPoint[] = [
  { point: '未封爵皇子是否要交冬衣钱', query: '冬衣 份例 内务府', mustHave: true },
  { point: '内务府采买谁管', query: '广储司 营造司' },
];

test('buildSelfFixPrompt 带上核查点、资料、硬约束与原文', () => {
  const p = buildSelfFixPrompt({
    project,
    chapter,
    entities: [],
    points,
    hits: [
      {
        forPoints: ['未封爵皇子是否要交冬衣钱'],
        docTitle: '清代皇子待遇',
        source: '史实.md',
        text: '皇子冬衣由内务府按例供给，不收钱。',
      },
    ],
  });
  assert.match(p.user, /冬衣钱/);
  assert.match(p.user, /按例供给/);
  assert.match(p.user, /清代皇子待遇/);
  assert.match(p.system, /固定项|硬约束/);
  assert.match(p.system, /不要编造史实/);
  assert.match(p.system, /"outline"/);
  assert.match(p.user, /太监上门收六两冬衣钱/);
});

test('parseSelfFix 解析正常结果', () => {
  const raw = JSON.stringify({
    outline: '新的大纲：份例照发但成色被克扣',
    beats: '1. 【冷院】冻醒',
    changes: [
      { point: '冬衣钱', verdict: 'fixed', action: '改成太监私索', source: '史实.md' },
      { point: '月银', verdict: 'ok', action: '符合' },
      { point: '机构名', verdict: 'unknown', action: '资料未覆盖' },
    ],
  });
  const r = parseSelfFix(raw);
  assert.equal(r.outline, '新的大纲：份例照发但成色被克扣');
  assert.equal(r.beats, '1. 【冷院】冻醒');
  assert.equal(r.changes.length, 3);
  assert.equal(r.changes[0]!.verdict, 'fixed');
  assert.equal(r.changes[0]!.source, '史实.md');
  assert.equal(r.changes[2]!.verdict, 'unknown');
});

test('parseSelfFix 容忍代码块与未知 verdict', () => {
  const raw =
    '```json\n{"outline":"甲","beats":"","changes":[{"point":"x","verdict":"weird","action":"y"}]}\n```';
  const r = parseSelfFix(raw);
  assert.equal(r.outline, '甲');
  assert.equal(r.changes[0]!.verdict, 'ok');
});

test('parseSelfFix 对非 JSON 抛错', () => {
  assert.throws(() => parseSelfFix('我改不了'), /没有返回可解析/);
});

test('parseSelfFix 限制改动条数', () => {
  const raw = JSON.stringify({
    outline: '甲',
    beats: '',
    changes: Array.from({ length: 20 }, (_, i) => ({ point: `p${i}`, verdict: 'ok', action: '' })),
  });
  assert.equal(parseSelfFix(raw).changes.length, 8);
});
