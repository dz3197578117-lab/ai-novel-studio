import type { StreamEvent } from '@novelforge/shared';
import { authHeaders } from './client';

export interface StreamCallbacks {
  onMeta?: (memoryUsed: NonNullable<Extract<StreamEvent, { type: 'meta' }>['memoryUsed']>) => void;
  onDelta: (text: string) => void;
  onDone: (fullText: string) => void;
  onError: (message: string) => void;
}

/** 与服务端一致：同时支持 LF 与 CRLF 的 SSE 分帧 */
function takeEvent(buffer: string): { raw: string; rest: string } | null {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  let idx = -1;
  let sepLen = 2;
  if (lf >= 0 && (crlf < 0 || lf < crlf)) {
    idx = lf;
  } else if (crlf >= 0) {
    idx = crlf;
    sepLen = 4;
  }
  if (idx < 0) return null;
  return { raw: buffer.slice(0, idx), rest: buffer.slice(idx + sepLen) };
}

/**
 * 读取 SSE 流。用 fetch + ReadableStream，因为 EventSource 不支持 POST。
 * 返回 abort 函数，供「停止生成」按钮调用。
 */
export function streamWrite(body: unknown, cb: StreamCallbacks): () => void {
  const controller = new AbortController();

  (async () => {
    try {
      const res = await fetch('/api/write/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        let msg = `生成失败 (${res.status})`;
        try {
          const j = (await res.json()) as { message?: string };
          msg = j.message ?? msg;
        } catch {
          /* ignore */
        }
        cb.onError(msg);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let frame: { raw: string; rest: string } | null;
        while ((frame = takeEvent(buffer)) !== null) {
          const raw = frame.raw;
          buffer = frame.rest;
          const line = raw.split(/\r?\n/).find((l) => l.startsWith('data:'));
          if (!line) continue;
          try {
            const ev = JSON.parse(line.slice(5).trim()) as StreamEvent;
            if (ev.type === 'delta') cb.onDelta(ev.text);
            else if (ev.type === 'meta') cb.onMeta?.(ev.memoryUsed);
            else if (ev.type === 'done') cb.onDone(ev.fullText);
            else if (ev.type === 'error') cb.onError(ev.message);
          } catch {
            /* 忽略不完整帧 */
          }
        }
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        cb.onError((e as Error).message);
      }
    }
  })();

  return () => controller.abort();
}
