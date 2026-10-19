import type { AiProviderConfig, ChatMessage, TokenUsage } from '@novelforge/shared';
import { getActiveProfile, toProviderConfig } from '../repos/settings.repo.js';

export interface StreamChatOptions {
  config: AiProviderConfig;
  messages: ChatMessage[];
  signal?: AbortSignal;
  /** 覆盖最大输出 tokens */
  maxTokens?: number;
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

// ───────────────────────── 重试与限流 ─────────────────────────

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 支持 `Retry-After: 秒` 与 HTTP 日期两种写法 */
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(header);
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return null;
}

/**
 * 带重试的 POST。
 * 生成的批次一多就会撞到服务商的 TPM/RPM 限流（429），
 * 这里按 Retry-After 或指数退避等待后重试，而不是直接失败给用户。
 */
async function postWithRetry(
  url: string,
  body: unknown,
  config: AiProviderConfig,
  signal?: AbortSignal,
): Promise<Response> {
  let lastDetail = '';
  let lastStatus = 0;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      // 网络层错误也重试一次
      if (attempt === MAX_ATTEMPTS - 1) throw e;
      await sleep(1500 * 2 ** attempt);
      continue;
    }

    if (res.ok) return res;

    lastStatus = res.status;
    lastDetail = await res.text().catch(() => '');

    if (!RETRY_STATUSES.has(res.status) || attempt === MAX_ATTEMPTS - 1) {
      break;
    }

    // 优先听服务商的 Retry-After，否则指数退避（2s, 4s, 8s）
    const waitMs = parseRetryAfter(res.headers.get('retry-after')) ?? 2000 * 2 ** attempt;
    await sleep(Math.min(waitMs, 30_000));
  }

  const hint =
    lastStatus === 429
      ? '（服务商限流：请求太频繁或每分钟 token 超限，稍等一会再试，或减少规划章数）'
      : '';
  throw new AiError(`模型请求失败 (${lastStatus})${hint}: ${lastDetail.slice(0, 400)}`, lastStatus);
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
  const { config, messages, signal, maxTokens } = opts;
  const url = joinUrl(config.baseUrl, '/chat/completions');

  const res = await postWithRetry(
    url,
    {
      model: config.model,
      messages,
      stream: true,
      temperature: config.temperature ?? 0.8,
      max_tokens: (maxTokens ?? config.maxTokens) || undefined,
    },
    config,
    signal,
  );

  if (!res.body) {
    throw new AiError('模型没有返回数据流', res.status);
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

/** 非流式补全的详细结果 */
export interface CompletionResult {
  content: string;
  /** 'stop' = 正常结束；'length' = 达到 max_tokens 被截断 */
  finishReason: string | null;
  usage?: TokenUsage;
}

export interface CompleteOptions {
  /** 覆盖配置里的最大输出 tokens（生成整本方案时需要更大的预算） */
  maxTokens?: number;
}

/**
 * 非流式补全（详细版）。
 * 拿得到 finishReason，调用方才能区分「模型没按格式写」和「输出被截断」。
 */
export async function completeDetailed(
  config: AiProviderConfig,
  messages: ChatMessage[],
  signal?: AbortSignal,
  opts: CompleteOptions = {},
): Promise<CompletionResult> {
  const url = joinUrl(config.baseUrl, '/chat/completions');
  const maxTokens = opts.maxTokens ?? config.maxTokens ?? undefined;
  const res = await postWithRetry(
    url,
    {
      model: config.model,
      messages,
      stream: false,
      temperature: config.temperature ?? 0.8,
      max_tokens: maxTokens || undefined,
    },
    config,
    signal,
  );
  const json = (await res.json()) as {
    choices?: {
      message?: { content?: string };
      finish_reason?: string;
    }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const choice = json.choices?.[0];
  return {
    content: choice?.message?.content ?? '',
    finishReason: choice?.finish_reason ?? null,
    usage: json.usage
      ? {
          promptTokens: json.usage.prompt_tokens ?? 0,
          completionTokens: json.usage.completion_tokens ?? 0,
        }
      : undefined,
  };
}

/** 非流式补全，只取文本（摘要等简单场景用） */
export async function complete(
  config: AiProviderConfig,
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<string> {
  return (await completeDetailed(config, messages, signal)).content;
}

/**
 * 用「流式」请求拿完整文本。
 *
 * 为什么不用非流式：生成整章/整批大纲可能跑 60 秒以上，
 * 多数服务商对长时间无数据的非流式请求会直接掐断连接（表现为 terminated）。
 * 流式下数据一直在流动，不会触发空闲超时。
 */
export async function completeAccumulated(
  config: AiProviderConfig,
  messages: ChatMessage[],
  opts: { maxTokens?: number; signal?: AbortSignal } = {},
): Promise<string> {
  let out = '';
  for await (const ev of streamChat({
    config,
    messages,
    signal: opts.signal,
    maxTokens: opts.maxTokens,
  })) {
    if (ev.type === 'delta') out += ev.text;
  }
  return out;
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
