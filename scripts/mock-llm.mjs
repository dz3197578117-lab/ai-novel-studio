/**
 * 模拟 OpenAI 兼容的 /v1/chat/completions 服务。
 * 用途：在没有真实 API Key 的情况下验证流式生成、上下文拼装、错误处理。
 * 启动：node scripts/mock-llm.mjs [port]
 */
import http from 'node:http';

const PORT = Number(process.argv[2] ?? 8899);

/** 假装是三段式生成的正文 */
const SAMPLE = [
  '外院的屋子比主宅冷得多。',
  '林尘推开门，雪从门缝里灌进来，扑在脸上，像无数细小的针。',
  '他没有生火。柴是有的，可他不想动。',
];

/** 模拟「策划一部小说」时返回的方案 JSON */
const DRAFT_SAMPLE = {
  title: '雪落长夜',
  logline: '被逐出家门的少年剑修，为洗清父亲冤屈而重返宗门，却发现真凶就在身边。',
  genre: '古典玄幻',
  styleGuide: '第三人称限知视角，叙述冷峻克制，白描为主，少用形容词，对话简短留白多。',
  entities: [
    {
      type: 'character',
      name: '沈砚',
      aliases: ['砚哥'],
      summary: '主角，十九岁，被逐出宗门的剑修，性子沉默执拗。',
      fields: [{ key: '年龄', value: '19' }, { key: '佩剑', value: '断水' }],
      body: '父亲被指私通外敌后失踪，他也被逐出青云宗。三年后携一柄断剑归来。',
      pinned: true,
    },
    {
      type: 'character',
      name: '苏烟',
      aliases: [],
      summary: '药阁学徒，与沈砚在雪夜相遇，心思缜密。',
      fields: [{ key: '年龄', value: '17' }],
      body: '她的师父似乎知道沈砚父亲失踪的真相。',
      pinned: false,
    },
    {
      type: 'faction',
      name: '青云宗',
      aliases: [],
      summary: '北域第一剑宗，内部分裂为三脉。',
      fields: [],
      body: '执法、问道、守拙三脉暗流涌动。',
      pinned: true,
    },
    {
      type: 'world',
      name: '北域',
      aliases: [],
      summary: '常年积雪的苦寒之地。',
      fields: [],
      body: '修行者以剑气御寒，境界分引气、凝脉、铸骨、通神。',
      pinned: false,
    },
    {
      type: 'item',
      name: '断水',
      aliases: [],
      summary: '沈砚的残剑，剑中残留父亲的一缕剑意。',
      fields: [],
      body: '剑身只剩半截，遇雪低鸣。',
      pinned: false,
    },
    {
      type: 'term',
      name: '守拙一脉',
      aliases: [],
      summary: '青云宗三脉之一，沈砚父亲原属此脉。',
      fields: [],
      body: '主张藏锋守拙，被执法一脉视为异端。',
      pinned: false,
    },
  ],
  volumes: [
    { title: '第一卷 · 雪夜归人', summary: '沈砚携断剑重归北域，在药阁与苏烟相遇，查得父亲旧案的第一条线索。' },
    { title: '第二卷 · 问剑青云', summary: '沈砚潜入青云宗外门，逐步接近真相，也与执法一脉正面冲突。' },
  ],
  chapters: [
    { volumeIndex: 0, title: '第一章 · 雪夜归人', outline: '沈砚冒雪回到北域，被宗门拒之门外，断剑第一次低鸣。' },
    { volumeIndex: 0, title: '第二章 · 药阁灯火', outline: '为治冻伤去药阁，遇见苏烟，得知父亲名字被人刻意抹去。' },
    { volumeIndex: 0, title: '第三章 · 旧宅残卷', outline: '在父亲旧宅夹墙里找到半卷名单，上面有执法一脉的名讳。' },
    { volumeIndex: 1, title: '第四章 · 外门试剑', outline: '沈砚隐姓埋名考入外门，试剑台上一剑击败内门弟子。' },
    { volumeIndex: 1, title: '第五章 · 暗流', outline: '执法一脉开始追查，沈砚身暴露，苏烟暗中传递消息。' },
    { volumeIndex: 1, title: '第六章 · 雪夜对峙', outline: '沈砚与执法长老雪夜对峙，断剑中的剑意第一次完整显形。' },
  ],
};

const server = http.createServer((req, res) => {
  if (req.url?.endsWith('/chat/completions') && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let parsed = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        /* ignore */
      }
      const stream = parsed.stream !== false;
      const lastUser = [...(parsed.messages ?? [])].reverse().find((m) => m.role === 'user');
      const system = (parsed.messages ?? []).find((m) => m.role === 'system');

      // 把收到的提示词记录下来，便于断言上下文是否正确注入
      console.log('\n=== MOCK REQUEST ===');
      console.log('RAW BODY (first 400):', body.slice(0, 400));
      console.log('model:', parsed.model, '| stream:', stream, '| temp:', parsed.temperature);
      console.log('system prompt chars:', system?.content?.length ?? 0);
      console.log('user prompt chars:', lastUser?.content?.length ?? 0);
      console.log('system has 设定:', /世界观与人物设定/.test(system?.content ?? ''));
      console.log('system has 前情提要:', /前情提要/.test(system?.content ?? ''));
      console.log('system has 本章大纲:', /本章大纲/.test(system?.content ?? ''));
      console.log('user tail:', String(lastUser?.content ?? '').slice(-80).replace(/\n/g, ' '));

      // 「策划一部小说」的请求返回方案 JSON，其余返回正文
      const isDraftRequest = /网络小说策划/.test(system?.content ?? '');
      // 分批生成章节大纲
      const isBatchRequest = /编写章节大纲/.test(system?.content ?? '');
      // 一致性检查
      const isCheckRequest = /检查长篇连载/.test(system?.content ?? '');
      // 分层创作：大纲→细纲、细纲→场景卡
      const isBeatsRequest = /小说结构编辑/.test(system?.content ?? '');
      const isScenesRequest = /小说场景设计师/.test(system?.content ?? '');
      const isRegenRequest = /单独重做\*\*第\s*\d+\s*章\*\*/.test(system?.content ?? '');
      // 对话式访谈：第一轮反问，第二轮给结论
      const isInterviewRequest = /小说策划助手/.test(system?.content ?? '');
      const userTurns = (String(lastUser?.content ?? '').match(/用户：/g) ?? []).length;
      console.log(
        'is draft request:', isDraftRequest,
        '| is batch:', isBatchRequest,
        '| is regen:', isRegenRequest,
        '| is interview:', isInterviewRequest,
        '| turns:', userTurns,
      );

      let content = SAMPLE.join('');
      if (isBeatsRequest) {
        content =
          '1. 【祠堂/除名】林尘跪在雪中听家主宣读除籍 → 他失去族籍\n' +
          '2. 【沉默】二叔经过却不发一言 → 家族彻底凉薄\n' +
          '3. 【离开】他起身走出祠堂 → 回望灯火，决心查父案\n' +
          '4. 【钩子】门槛下摸出半截断剑 → 剑中剑意低鸣';
      } else if (isScenesRequest) {
        content = JSON.stringify({
          scenes: [
            {
              title: '祠堂除名',
              pov: '林尘',
              location: '祠堂前',
              goal: '保住族籍',
              conflict: '家主已定罪，族人无人说话',
              outcome: '被逐出主宅',
              keyLines: '「念你年幼，不予追究。」',
            },
            {
              title: '断剑低鸣',
              pov: '林尘',
              location: '外院废宅',
              goal: '找父亲遗物',
              conflict: '屋内被人翻找过',
              outcome: '拿到残剑，感到熟悉剑意',
              keyLines: '「留给心不细的人。」',
            },
          ],
        });
      } else if (isCheckRequest) {
        content = JSON.stringify({
          issues: [
            {
              kind: 'character',
              severity: 'high',
              title: '主角性格前后不一致',
              detail: '设定里林尘沉默寡言，但第三章突然变得油嘴滑舌。',
              suggestion: '把第三章的对话改回简短、克制的表达。',
              refs: ['林尘', '第三章 · 药阁少女'],
            },
            {
              kind: 'foreshadow',
              severity: 'medium',
              title: '伏笔「北境的塔」尚未回收',
              detail: '第二章埋下，至今未提。',
              suggestion: '在近期章节安排一次呼应，或标记为放弃。',
              refs: ['北境的塔'],
            },
          ],
        });
      } else if (isRegenRequest) {
        const n = /第\s*(\d+)\s*章/.exec(system?.content ?? '')?.[1] ?? '1';
        content = JSON.stringify({
          volumeIndex: 0,
          title: `第${n}章 · 重做版标题`,
          outline: `重做后的第${n}章大纲：新的冲突与钩子。`,
        });
      } else if (isBatchRequest) {
        // 按提示词里给定的章号与卷号返回对应数量的章节
        const asked = [...String(lastUser?.content ?? '').matchAll(
          /第\s*(\d+)\s*章\s*→\s*volumeIndex\s*(\d+)/g,
        )];
        content = JSON.stringify({
          chapters: asked.map((m) => ({
            volumeIndex: Number(m[2]),
            // 故意用「第1章」开头，验证服务端会不会纠正成全局连续编号
            title: `第1章 · 模拟章节${m[1]}`,
            outline: `模拟大纲：第 ${m[1]} 章的冲突。`,
          })),
        });
      } else if (isDraftRequest) {
        content = JSON.stringify(DRAFT_SAMPLE);
      } else if (isInterviewRequest) {
        content = JSON.stringify(
          userTurns <= 1
            ? {
                say: '你想写哪种类型的小说？先定个大方向，我来帮你细化。',
                options: ['古典玄幻', '都市悬疑', '科幻末世'],
                done: false,
                brief: '',
              }
            : {
                say: '明白了，我按这个方向出一版方案。',
                options: [],
                done: true,
                brief:
                  '古典玄幻长篇。主角是被逐出宗门的剑修，为洗清父亲冤屈重返北域，追查中发现真凶就在宗门内部。基调冷峻克制，白描为主，适合长篇连载。',
              },
        );
      }

      if (!stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content } }],
            usage: { prompt_tokens: 100, completion_tokens: 50 },
          }),
        );
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      let i = 0;
      const timer = setInterval(() => {
        if (i >= SAMPLE.length) {
          clearInterval(timer);
          res.write(
            `data: ${JSON.stringify({
              choices: [{ delta: {} }],
              usage: { prompt_tokens: 320, completion_tokens: 48 },
            })}\n\n`,
          );
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: SAMPLE[i] } }] })}\n\n`,
        );
        i++;
      }, 60);

      // 注意：必须监听 res 的 close，而不是 req 的 close。
      // Node 新版在请求体读完后就会触发 req 'close'，会立刻清掉定时器。
      res.on('close', () => clearInterval(timer));
    });
    return;
  }

  // 模型列表（OpenAI 兼容 GET /v1/models）
  if (req.url?.endsWith('/models') && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        object: 'list',
        data: [
          { id: 'mock-model', object: 'model' },
          { id: 'mock-model-mini', object: 'model' },
          { id: 'mock-reasoner', object: 'model' },
        ],
      }),
    );
    return;
  }

  // 图像生成（可选路径）
  if (req.url?.endsWith('/images/generations') && req.method === 'POST') {
    // 1x1 透明 PNG
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ b64_json: png }] }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Mock LLM listening on http://127.0.0.1:${PORT}/v1`);
});
