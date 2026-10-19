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

      if (!stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: SAMPLE.join('') } }],
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
