import type { FastifyInstance } from 'fastify';
import type { AiProviderConfig, ImageProviderConfig, Settings } from '@novelforge/shared';
import { getSetting, setSetting } from '../repos/settings.repo.js';
import { settingsInput } from './schemas.js';

/** 打码：只显示前 3 后 4 位，前端不回传真实 Key */
function mask(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 3)}••••${key.slice(-4)}`;
}

/**
 * 决定最终保存的 secret 值：
 * - undefined（字段未提交）→ 保留原值
 * - 含打码符（前端回显）→ 保留原值
 * - 空串 → 用户主动清空
 * - 其他 → 当作新 Key
 */
function resolveSecret(incoming: string | undefined, current: string): string {
  if (incoming === undefined) return current;
  if (incoming.includes('••••')) return current;
  return incoming;
}

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/settings', async (): Promise<Settings> => {
    const text = getSetting<AiProviderConfig>('text', {
      baseUrl: '',
      apiKey: '',
      model: '',
      temperature: 0.85,
      maxTokens: 4096,
    });
    const image = getSetting<ImageProviderConfig>('image', {
      baseUrl: '',
      apiKey: '',
      model: '',
    });
    return {
      text: { ...text, apiKey: mask(text.apiKey) },
      image: { ...image, apiKey: mask(image.apiKey) },
      hasTextKey: Boolean(text.apiKey),
      hasImageKey: Boolean(image.apiKey),
    };
  });

  app.put('/api/settings', async (req, reply) => {
    const parsed = settingsInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_input',
        message: '参数校验失败',
        details: parsed.error.flatten(),
      });
    }

    if (parsed.data.text) {
      const cur = getSetting<AiProviderConfig>('text', {
        baseUrl: '',
        apiKey: '',
        model: '',
        temperature: 0.85,
        maxTokens: 4096,
      });
      const next: AiProviderConfig = {
        baseUrl: parsed.data.text.baseUrl,
        model: parsed.data.text.model,
        temperature: parsed.data.text.temperature ?? cur.temperature,
        maxTokens: parsed.data.text.maxTokens ?? cur.maxTokens,
        // undefined = 未提交该字段，保留原值
        // 含打码符 = 前端回显的掩码，保留原值
        // 空串 = 用户主动清空
        // 其他 = 新 Key
        apiKey: resolveSecret(parsed.data.text.apiKey, cur.apiKey),
      };
      setSetting('text', next);
    }

    if (parsed.data.image) {
      const cur = getSetting<ImageProviderConfig>('image', {
        baseUrl: '',
        apiKey: '',
        model: '',
      });
      const next: ImageProviderConfig = {
        baseUrl: parsed.data.image.baseUrl,
        model: parsed.data.image.model,
        apiKey: resolveSecret(parsed.data.image.apiKey, cur.apiKey),
      };
      setSetting('image', next);
    }

    return { ok: true };
  });

  /** 连通性测试：发一个极小请求验证配置可用 */
  app.post('/api/settings/test', async (_req, reply) => {
    const text = getSetting<AiProviderConfig>('text', {
      baseUrl: '',
      apiKey: '',
      model: '',
      temperature: 0.85,
      maxTokens: 4096,
    });
    if (!text.apiKey || !text.baseUrl) {
      return reply.code(412).send({ error: 'not_configured', message: '请先填写 Base URL 与 API Key' });
    }
    try {
      const { complete } = await import('../ai/client.js');
      const out = await complete(text, [{ role: 'user', content: '回复两个字：可用' }]);
      return { ok: true, sample: out.slice(0, 50) };
    } catch (e) {
      return reply.code(502).send({ error: 'upstream_error', message: (e as Error).message });
    }
  });
}
