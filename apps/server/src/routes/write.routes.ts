import type { FastifyInstance } from 'fastify';
import type { StreamEvent } from '@novelforge/shared';
import { buildContext, summaryPrompt } from '../ai/context.js';
import { AiError, complete, loadTextConfig, streamChat } from '../ai/client.js';
import { getChapter, setChapterSummary, updateChapter } from '../repos/chapters.repo.js';
import { getProject } from '../repos/projects.repo.js';
import { writeRequest } from './schemas.js';

export async function writeRoutes(app: FastifyInstance): Promise<void> {
  /**
   * 流式写作。用 SSE 手工写流，避免引入额外依赖。
   * 前端用 fetch + ReadableStream 读取，不用 EventSource（POST 不支持）。
   */
  app.post('/api/write/stream', async (req, reply) => {
    const parsed = writeRequest.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_input',
        message: '参数校验失败',
        details: parsed.error.flatten(),
      });
    }
    const { projectId, chapterId, mode, instruction, selection, memoryBudget } = parsed.data;

    const project = getProject(projectId);
    if (!project) return reply.code(404).send({ error: 'not_found', message: '项目不存在' });
    const chapter = getChapter(chapterId);
    if (!chapter) return reply.code(404).send({ error: 'not_found', message: '章节不存在' });

    let config;
    try {
      config = loadTextConfig();
    } catch (e) {
      if (e instanceof AiError) {
        return reply.code(412).send({ error: 'not_configured', message: e.message });
      }
      throw e;
    }

    const ctx = buildContext({ project, chapter, mode, instruction, selection, memoryBudget });

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (ev: StreamEvent) => {
      reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
    };

    const controller = new AbortController();
    // 注意：必须监听响应流的 close，而不是 req.raw.
    // Node 新一代中 IncomingMessage 的 'close' 在请求体读完后即触发，
    // 会导致生成刚发出就被 abort（表现为只收到 meta 没有正文）。
    reply.raw.on('close', () => {
      if (!reply.raw.writableEnded) controller.abort();
    });

    send({ type: 'meta', memoryUsed: ctx.memoryUsed });

    let full = '';
    try {
      for await (const chunk of streamChat({
        config,
        messages: [
          { role: 'system', content: ctx.system },
          { role: 'user', content: ctx.user },
        ],
        signal: controller.signal,
      })) {
        if (chunk.type === 'delta') {
          full += chunk.text;
          send({ type: 'delta', text: chunk.text });
        } else if (chunk.type === 'usage') {
          send({ type: 'done', fullText: full, usage: chunk.usage });
          full = '';
        }
      }
      if (full) send({ type: 'done', fullText: full });
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        send({ type: 'error', message: (e as Error).message });
      }
    } finally {
      reply.raw.end();
    }
  });

  /** 为某一章生成/更新摘要，写入长期记忆 */
  app.post<{ Params: { id: string } }>('/api/chapters/:id/summarize', async (req, reply) => {
    const chapter = getChapter(req.params.id);
    if (!chapter) return reply.code(404).send({ error: 'not_found', message: '章节不存在' });
    if (!chapter.content.trim()) {
      return reply.code(400).send({ error: 'empty', message: '章节没有正文，无法生成摘要' });
    }

    let config;
    try {
      config = loadTextConfig();
    } catch (e) {
      if (e instanceof AiError) {
        return reply.code(412).send({ error: 'not_configured', message: e.message });
      }
      throw e;
    }

    const p = summaryPrompt(chapter);
    const summary = await complete(config, [
      { role: 'system', content: p.system },
      { role: 'user', content: p.user },
    ]);
    setChapterSummary(chapter.id, summary.trim());
    return { summary: summary.trim() };
  });

  /** 把生成结果落到章节正文（支持追加或替换） */
  app.post<{
    Params: { id: string };
    Body: { text?: string; append?: boolean };
  }>('/api/chapters/:id/apply', async (req, reply) => {
    const chapter = getChapter(req.params.id);
    if (!chapter) return reply.code(404).send({ error: 'not_found', message: '章节不存在' });
    const text = req.body?.text ?? '';
    if (!text.trim()) {
      return reply.code(400).send({ error: 'invalid_input', message: 'text 不能为空' });
    }
    const content = req.body?.append === false ? text : chapter.content + text;
    const updated = updateChapter(chapter.id, {
      content,
      status: chapter.status === 'outline' ? 'drafting' : chapter.status,
    });
    return updated;
  });
}
