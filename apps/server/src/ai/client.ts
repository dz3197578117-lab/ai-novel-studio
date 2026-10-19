import type { AiProviderConfig, ChatMessage, TokenUsage } from '@novelforge/shared';
import { getActiveProfile, toProviderConfig } from '../repos/settings.repo.js';

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
 * 读取「当前生效」的那套模型配置。没配置或没 Key 时抛错，
 * 提示用户去设置页选一套或补充 Key。
 */
export function loadTextConfig(): AiProviderConfig {
  const profile = getActiveProfile();
  if (!profile) {
    throw new AiError('还没有任何模型配置，请先在「设置」里添加一个模型。');
  }
  if (!profile.apiKey) {
    throw new AiError(
      `当前模型「${profile.name}」还没填 API Key，请先到「设置」里补上，或切换到其它配置。`,
    );
  }
  return toProviderConfig(profile);
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

/**
 * 拉取服务商支持的模型列表（OpenAI 兼容的 GET /models）。
 * 不同厂商返回结构略有差异，这里兼容 data[].id 与 models[].id 两种。
 */
export async function fetchModels(
  baseUrl: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const url = joinUrl(baseUrl, '/models');
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    });
  } catch (e) {
    throw new AiError(`连不上 ${url}：${(e as Error).message}`);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new AiError(
      `获取模型列表失败 (${res.status})：${detail.slice(0, 300)}`,
      res.status,
    );
  }

  const json = (await res.json()) as {
    data?: { id?: string }[];
    models?: { id?: string; name?: string }[];
  };

  const ids = [
    ...(json.data ?? []).map((m) => m.id),
    ...(json.models ?? []).map((m) => m.id ?? m.name),
  ].filter((s): s is string => typeof s === 'string' && s.length > 0);

  // 去重并排序，方便查找
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}
