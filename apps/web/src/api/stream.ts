import type { StreamEvent } from '@novelforge/shared';

export interface StreamCallbacks {
  onMeta?: (memoryUsed: NonNullable<Extract<StreamEvent, { type: 'meta' }>['memoryUsed']>) => void;
  onDelta: (text: string) => void;
  onDone: (fullText: string) => void;
  onError: (message: string) => void;
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
        headers: { 'Content-Type': 'application/json' },
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

        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const line = raw.split('\n').find((l) => l.startsWith('data:'));
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
