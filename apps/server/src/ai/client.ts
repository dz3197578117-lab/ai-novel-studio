import type { AiProviderConfig, ChatMessage, TokenUsage } from '@novelforge/shared';
import { getSetting } from '../repos/settings.repo.js';

export interface StreamChatOptions {
  config: AiProviderConfig;
  messages: ChatMessage[];
  signal?: AbortSignal;
}

export class AiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AiError';
  }
}

/**
 * 读取已保存的文本模型配置。Key 为空时抛错，提示用户先去设置页填写。
 */
export function loadTextConfig(): AiProviderConfig {
  const cfg = getSetting<AiProviderConfig | null>('text', null);
  if (!cfg || !cfg.apiKey) {
    throw new AiError('尚未配置文本模型，请先在「设置」中填写 Base URL / API Key / 模型名。');
  }
  return cfg;
}

/**
 * OpenAI 兼容的流式对话。所有主流厂商（DeepSeek/OpenAI/通义/Ollama/vLLM）
 * 都实现了 /chat/completions + SSE，因此这里只写一份。
 */
export async function* streamChat(opts: StreamChatOptions): AsyncGenerator<
  { type: 'delta'; text: string } | { type: 'usage'; usage: TokenUsage }
> {
  const { config, messages, signal } = opts;
  const url = joinUrl(config.baseUrl, '/chat/completions');

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      stream: true,
      temperature: config.temperature ?? 0.8,
      max_tokens: config.maxTokens || undefined,
    }),
    signal,
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    throw new AiError(`模型请求失败 (${res.status}): ${detail.slice(0, 500)}`, res.status);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE 以空行分隔事件
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const line = raw.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;

      try {
        const json = JSON.parse(payload);
        const delta = json.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta.length > 0) {
          yield { type: 'delta', text: delta };
        }
        if (json.usage) {
          yield {
            type: 'usage',
            usage: {
              promptTokens: json.usage.prompt_tokens ?? 0,
              completionTokens: json.usage.completion_tokens ?? 0,
            },
          };
        }
      } catch {
        // 忽略无法解析的心跳
      }
    }
  }
}

/** 非流式补全，用于摘要/起名等一次性任务 */
export async function complete(
  config: AiProviderConfig,
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<string> {
  const url = joinUrl(config.baseUrl, '/chat/completions');
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      stream: false,
      temperature: config.temperature ?? 0.8,
      max_tokens: config.maxTokens || undefined,
    }),
    signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new AiError(`模型请求失败 (${res.status}): ${detail.slice(0, 500)}`, res.status);
  }
  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return json.choices?.[0]?.message?.content ?? '';
}

function joinUrl(base: string, suffix: string): string {
  const b = base.replace(/\/+$/, '');
  // 允许用户直接粘贴到 /chat/completions 的完整地址
  if (b.endsWith('/chat/completions')) return b;
  return `${b}${suffix}`;
}
