import type { FastifyInstance } from 'fastify';
import type { StreamEvent, TokenUsage } from '@novelforge/shared';
import { buildContext, summaryPrompt, CHAPTER_MODES, CHAPTER_WORD_RANGE } from '../ai/context.js';
import { AiError, complete, loadTextConfig, streamChat } from '../ai/client.js';
import { countWords } from '../db.js';
import { getChapter, setChapterSummary, updateChapter } from '../repos/chapters.repo.js';
import { getProject } from '../repos/projects.repo.js';
import { writeRequest } from './schemas.js';

/** 去掉模型擅自写在正文开头的章节标题行 */
export function stripLeadingHeading(text: string): string {
  return text
    .replace(/^\s*#{1,6}\s*第[一二三四五六七八九十百千\d]+章[^\n]*\n+/, '')
    .replace(/^\s*第[一二三四五六七八九十百千\d]+章\s*[·・\-—]?[^\n]*\n+/, '')
    .replace(/^\s*#{1,6}\s*第[一二三四五六七八九十百千\d]章\s*[^\n]*$/, '')
    .replace(/^\s*[-—*]{3,}\s*\n+/, '')
    .trimStart();
}

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

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

    /**
     * 心跳：推理模型可能几十秒不吐第一个字，中间的代理/浏览器会把「无数据」的连接掐掉。
     * SSE 注释帧不会被前端解析成事件（前端只认 data: 行）。
     */
    const heartbeat = setInterval(() => {
      if (!reply.raw.writableEnded) reply.raw.write(': ping\n\n');
    }, 15_000);

    const controller = new AbortController();
    // 注意：必须监听响应流的 close，而不是 req.raw.
    // Node 新一代中 IncomingMessage 的 'close' 在请求体读完后即触发，
    // 会导致生成刚发出就被 abort（表现为只收到 meta 没有正文）。
    reply.raw.on('close', () => {
      if (!reply.raw.writableEnded) controller.abort();
    });

    send({ type: 'meta', memoryUsed: ctx.memoryUsed });

    let full = '';
    let usage: TokenUsage | undefined;

    /**
     * 章节模式：先把开头一小段扣住，检测到模型擅自加了「第三章 · xxx」这类标题就丢掉。
     * 直接透传的话标题会混进正文，之后还得手工清。
     */
    const isChapterMode = CHAPTER_MODES.includes(mode);
    let headPending = '';
    let headDone = false;
    const pushText = (text: string) => {
      if (!isChapterMode || headDone) {
        full += text;
        send({ type: 'delta', text });
        return;
      }
      headPending += text;
      if (headPending.length < 120) return;
      headDone = true;
      const cleaned = stripLeadingHeading(headPending);
      headPending = '';
      if (cleaned) {
        full += cleaned;
        send({ type: 'delta', text: cleaned });
      }
    };
    const flushHead = () => {
      if (!isChapterMode || headDone) return;
      headDone = true;
      const cleaned = stripLeadingHeading(headPending);
      headPending = '';
      if (cleaned) {
        full += cleaned;
        send({ type: 'delta', text: cleaned });
      }
    };

    const streamOnce = async (messages: ChatMessage[]) => {
      for await (const chunk of streamChat({
        config,
        messages,
        signal: controller.signal,
      })) {
        if (chunk.type === 'delta') {
          pushText(chunk.text);
        } else if (chunk.type === 'usage') {
          usage = chunk.usage;
        }
      }
    };

    try {
      await streamOnce([
        { role: 'system', content: ctx.system },
        { role: 'user', content: ctx.user },
      ]);

      // 整章太短就自动续写，直到达到下限或轮数用完
      if (isChapterMode) {
        for (let round = 0; round < 3; round++) {
          flushHead();
          const have = countWords(full);
          if (have >= CHAPTER_WORD_RANGE.min) break;
          if (controller.signal.aborted) break;

          const want = Math.max(
            800,
            Math.min(CHAPTER_WORD_RANGE.min + 500, CHAPTER_WORD_RANGE.max) - have,
          );
          const tail = full.slice(-1600);
          send({ type: 'meta', memoryUsed: [] });
          await streamOnce([
            { role: 'system', content: ctx.system },
            {
              role: 'user',
              content:
                `你正在写同一章的正文，目前写到 ${have} 字。请**直接从断点继续写**：\n` +
                `- 不要重复已写内容，不要重新开头，不要写章节标题\n` +
                `- 保持人称、称谓与文风不变\n` +
                `- 这一轮再写约 ${want} 字，把本章该发生的事写完，结尾留钩子\n\n` +
                `## 已写正文的最后部分\n${tail}\n\n直接续写正文。`,
            },
          ]);
        }
        flushHead();
      }

      send({ type: 'done', fullText: full, usage });
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        send({ type: 'error', message: (e as Error).message });
      }
    } finally {
      clearInterval(heartbeat);
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
    const updated = updateChapter(
      chapter.id,
      {
        content,
        status: chapter.status === 'outline' ? 'drafting' : chapter.status,
      },
      // AI 整章替换前强制留一份原稿
      { snapshotReason: 'ai-apply', forceSnapshot: true },
    );
    return updated;
  });
}
