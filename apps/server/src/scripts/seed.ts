/**
 * 生成一份演示作品，方便第一次启动时看到完整效果。
 * 运行：pnpm seed
 */
import { createProject, listProjects, updateProject } from '../repos/projects.repo.js';
import { createEntity } from '../repos/entities.repo.js';
import { createChapter, createVolume, updateChapter, setChapterSummary } from '../repos/chapters.repo.js';
import { getDb } from '../db.js';

const DEMO_TITLE = '长夜行';

function main() {
  getDb();

  const existing = listProjects().find((p) => p.title === DEMO_TITLE);
  if (existing) {
    console.log(`演示作品已存在：${existing.id}`);
    return;
  }

  const project = createProject({
    title: DEMO_TITLE,
    logline: '被逐出家门的少年剑修，在漫长的雪夜里追查父亲失踪的真相。',
    genre: '古典玄幻',
    targetWords: 800_000,
    styleGuide:
      '第三人称限知视角。叙述冷峻克制，白描为主，少用形容词堆砌。对话简短，留白多。环境描写服务于情绪，不写无意义的景物。',
  });

  updateProject(project.id, { status: 'drafting' });

  // ── 设定 ──
  createEntity(project.id, {
    type: 'character',
    name: '林尘',
    aliases: ['尘弟', '林师兄'],
    summary: '主角，十七岁，被逐出家门的林家旁支少年，剑道天赋极高。',
    fields: [
      { key: '年龄', value: '17' },
      { key: '佩剑', value: '断雪（残剑）' },
      { key: '性格', value: '沉默、执拗，认死理' },
    ],
    body:
      '自幼丧母，父亲林远山在他十岁时失踪。因不肯承认家族对他父亲的指控，被家主逐出主宅，迁居外院。\n' +
      '机缘下获得一柄断剑，剑中残留着父亲的一缕剑意。',
    pinned: true,
  });

  createEntity(project.id, {
    type: 'character',
    name: '苏晚',
    aliases: ['晚姑娘'],
    summary: '药阁少女，擅长医术，与林尘在雪夜相遇。',
    fields: [
      { key: '年龄', value: '16' },
      { key: '身份', value: '回春药阁学徒' },
    ],
    body: '看似温和，实则心思缜密。她的师父与林尘父亲的失踪有关。',
    pinned: true,
  });

  createEntity(project.id, {
    type: 'faction',
    name: '青云宗',
    summary: '北域第一剑宗，表面正派，内部分裂为三脉。',
    body: '三脉分别为执法、问道、守拙。家主林远山原属守拙一脉。',
    pinned: true,
  });

  createEntity(project.id, {
    type: 'world',
    name: '北域',
    summary: '常年积雪的苦寒之地，修行者以剑气御寒。',
    body: '北域分九州，冬季长达半年。修行界以「境」分层次：引气、凝脉、铸骨、通神、化虚。',
    pinned: true,
  });

  createEntity(project.id, {
    type: 'term',
    name: '断雪',
    summary: '林尘的残剑，剑中封印着林远山的一缕剑意。',
    body: '剑身只剩半截，通体青黑，遇雪会发出低鸣。',
    pinned: false,
  });

  // ── 卷与章节 ──
  const v1 = createVolume(project.id, '第一卷 · 雪夜出族', '林尘被逐出家门，雪夜偶得断剑，与苏晚相遇，踏上追查父亲下落的路。');
  const v2 = createVolume(project.id, '第二卷 · 问剑青云', '林尘入青云宗外门，逐渐接近父亲失踪的真相。');

  const chapters = [
    {
      volumeId: v1.id,
      title: '第一章 · 雪落祠堂',
      outline:
        '林尘被家主当众逐出主宅，跪在祠堂前接受除名。雪夜中他离开，回望家族灯火。确立主角处境、家族矛盾、父亲的疑点。',
      content:
        '雪落了三日。\n\n' +
        '林尘跪在祠堂前，膝盖早已冻得没有知觉。檐上的雪积了半尺，压得瓦片吱呀作响。\n\n' +
        '家主的声音从门里传出来，不高，却比风雪更冷。\n\n' +
        '「林尘，你父林远山私通外敌，罪证确凿。今日除你族籍，逐出主宅。念你年幼，不予追究。」\n\n' +
        '他没有抬头。\n\n' +
        '祠堂的门开了又关。有人从他身边走过，衣角扫起一小片雪。他认得那双鞋——是二叔的。二叔没有停。\n\n' +
        '林尘在雪里跪到天黑。',
      status: 'done' as const,
    },
    {
      volumeId: v1.id,
      title: '第二章 · 断剑',
      outline: '林尘搬入外院废宅，在父亲留下的旧物中发现半截断剑。触碰时感到一丝熟悉的剑意。',
      content: '',
      status: 'outline' as const,
    },
    {
      volumeId: v1.id,
      title: '第三章 · 药阁少女',
      outline: '林尘因冻伤去回春药阁求医，遇到苏晚。苏晚似乎认识他父亲的名字。',
      content: '',
      status: 'outline' as const,
    },
    {
      volumeId: v2.id,
      title: '第四章 · 外门试剑',
      outline: '林尘考入青云宗外门，在试剑台上第一次展露实力，引起执法一脉注意。',
      content: '',
      status: 'outline' as const,
    },
  ];

  for (const c of chapters) {
    const created = createChapter(project.id, {
      title: c.title,
      volumeId: c.volumeId,
      outline: c.outline,
      content: c.content,
      status: c.status,
    });
    if (c.status === 'done' && c.content) {
      setChapterSummary(
        created.id,
        '林尘被家主以「父通外敌」为由除籍逐出主宅，在祠堂前雪夜跪至天黑，二叔等族中长辈皆未出言。初步坐实父亲被冤的疑点。',
      );
      updateChapter(created.id, { content: c.content });
    }
  }

  console.log(`演示作品「${DEMO_TITLE}」已创建：${project.id}`);
  console.log('包含 5 条设定、2 卷、4 章。');
}

main();
