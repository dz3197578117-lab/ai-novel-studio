import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Chapter, Project } from '@novelforge/shared';
import { buildPlanRevisePrompt, cleanPlanOutput } from '../ai/plan.js';

const project = {
  id: 'p1',
  title: '打脸结算系统',
  logline: '穷学生绑定按秒结算系统',
  genre: '都市',
  styleGuide: '短句、快节奏',
  targetWords: 0,
  status: 'drafting',
  createdAt: '',
  updatedAt: '',
} as Project;

const chapter = {
  id: 'c1',
  projectId: 'p1',
  volumeId: null,
  title: '第22章 · 猎手的第一张网',
  order: 21,
  outline: '林砚在校招会被HR嫌弃学历，随后反击。',
  beats: '1. 【校招会】被嫌弃 → 围观\n2. 【反击】报估值 → 笑声停',
  content: '',
  status: 'outline',
  wordCount: 0,
  summary: '',
  createdAt: '',
  updatedAt: '',
} as Chapter;

const prev = { ...chapter, id: 'c0', title: '第21章 · 同学会', outline: '主桌上的羞辱' } as Chapter;
const next = { ...chapter, id: 'c2', title: '第23章 · 空账户', outline: '账户被冻结' } as Chapter;

test('ask 模式：带上问题、前后章与伏笔，不要求输出文本', () => {
  const p = buildPlanRevisePrompt({
    mode: 'ask',
    field: 'outline',
    project,
    chapter,
    prev,
    next,
    openForeshadows: ['北境的塔'],
    instruction: '这章会不会跟第21章冲突？',
  });
  assert.match(p.user, /这章会不会跟第21章冲突/);
  assert.match(p.user, /第21章 · 同学会/);
  assert.match(p.user, /第23章 · 空账户/);
  assert.match(p.user, /北境的塔/);
  assert.match(p.system, /直接回答作者的问题/);
  assert.doesNotMatch(p.system, /只输出修改后/);
});

test('revise 模式：细纲要 5-8 拍并给钩子', () => {
  const p = buildPlanRevisePrompt({
    mode: 'revise',
    field: 'beats',
    project,
    chapter,
    prev: null,
    next: null,
    openForeshadows: [],
    instruction: '压成三拍，冲突提前',
  });
  assert.match(p.system, /只输出修改后的本章细纲/);
  assert.match(p.system, /钩子/);
  assert.match(p.user, /压成三拍/);
});

test('revise 模式：大纲要 60-120 字', () => {
  const p = buildPlanRevisePrompt({
    mode: 'revise',
    field: 'outline',
    project,
    chapter,
    prev: null,
    next: null,
    openForeshadows: [],
    instruction: '结尾改成反转',
  });
  assert.match(p.system, /60-120 字/);
});

test('cleanPlanOutput 去掉代码块与前缀', () => {
  assert.equal(cleanPlanOutput('```\n新的大纲内容\n```', 'outline'), '新的大纲内容');
  assert.equal(cleanPlanOutput('修改后的大纲：内容甲', 'outline'), '内容甲');
  assert.equal(cleanPlanOutput('以下是细纲:内容乙', 'beats'), '内容乙');
  assert.equal(cleanPlanOutput('  内容丙  ', 'outline'), '内容丙');
});
