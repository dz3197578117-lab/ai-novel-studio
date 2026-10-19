import type { FastifyInstance } from 'fastify';
import type { ImageProviderConfig, ModelProfilePublic, Settings } from '@novelforge/shared';
import {
  createProfile,
  deleteProfile,
  getActiveProfileId,
  getImageConfig,
  getProfile,
  getProfiles,
  maskKey,
  resolveSecret,
  setActiveProfileId,
  setImageConfig,
  toProviderConfig,
  updateProfile,
  type StoredProfile,
} from '../repos/settings.repo.js';
import { fetchModels } from '../ai/client.js';
import { fetchModelsInput, imageSettingsInput, profileInput } from './schemas.js';

function toPublic(p: StoredProfile): ModelProfilePublic {
  const { apiKey, ...rest } = p;
  return { ...rest, apiKeyMasked: maskKey(apiKey), hasApiKey: Boolean(apiKey) };
}

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  /** 读取全部配置（Key 打码） */
  app.get('/api/settings', async (): Promise<Settings> => {
    const profiles = getProfiles();
    const image = getImageConfig();
    return {
      profiles: profiles.map(toPublic),
      activeProfileId: getActiveProfileId() ?? profiles[0]?.id ?? null,
      image: { ...image, apiKey: maskKey(image.apiKey) },
      hasImageKey: Boolean(image.apiKey),
    };
  });

  /** 新增一套模型配置 */
  app.post('/api/profiles', async (req, reply) => {
    const parsed = profileInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_input',
        message: '参数校验失败',
        details: parsed.error.flatten(),
      });
    }
    const d = parsed.data;
    const created = createProfile({
      name: d.name,
      baseUrl: d.baseUrl,
      apiKey: d.apiKey ?? '',
      model: d.model,
      temperature: d.temperature ?? 0.85,
      maxTokens: d.maxTokens ?? 4096,
    });
    return reply.code(201).send(toPublic(created));
  });

  /** 编辑一套配置（Key 语义见 resolveSecret） */
  app.patch<{ Params: { id: string } }>('/api/profiles/:id', async (req, reply) => {
    const cur = getProfile(req.params.id);
    if (!cur) return reply.code(404).send({ error: 'not_found', message: '配置不存在' });

    const parsed = profileInput.partial().safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_input',
        message: '参数校验失败',
        details: parsed.error.flatten(),
      });
    }
    const d = parsed.data;
    const next = updateProfile(cur.id, {
      name: d.name ?? cur.name,
      baseUrl: d.baseUrl ?? cur.baseUrl,
      model: d.model ?? cur.model,
      temperature: d.temperature ?? cur.temperature,
      maxTokens: d.maxTokens ?? cur.maxTokens,
      apiKey: resolveSecret(d.apiKey, cur.apiKey),
    });
    return toPublic(next!);
  });

  app.delete<{ Params: { id: string } }>('/api/profiles/:id', async (req, reply) => {
    const ok = deleteProfile(req.params.id);
    if (!ok) return reply.code(404).send({ error: 'not_found', message: '配置不存在' });
    return { ok: true, activeProfileId: getActiveProfileId() };
  });

  /** 切换当前使用哪套配置 */
  app.post<{ Params: { id: string } }>('/api/profiles/:id/activate', async (req, reply) => {
    const p = getProfile(req.params.id);
    if (!p) return reply.code(404).send({ error: 'not_found', message: '配置不存在' });
    setActiveProfileId(p.id);
    return { ok: true, activeProfileId: p.id };
  });

  /**
   * 拉取服务商支持的模型列表。
   * 既用于「填写新配置时拉列表」，也用于「测试已保存配置是否可用」。
   */
  app.post('/api/models', async (req, reply) => {
    const parsed = fetchModelsInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_input',
        message: '参数校验失败',
        details: parsed.error.flatten(),
      });
    }
    const { baseUrl, apiKey, profileId } = parsed.data;

    let key = apiKey ?? '';
    let url = baseUrl ?? '';
    if (profileId) {
      const p = getProfile(profileId);
      if (!p) return reply.code(404).send({ error: 'not_found', message: '配置不存在' });
      url = url || p.baseUrl;
      // 前端回传打码值时用库里真实的 Key
      key = key.includes('••••') || !key ? p.apiKey : key;
    }

    if (!url) {
      return reply.code(400).send({ error: 'invalid_input', message: '请先填写 Base URL' });
    }
    if (!key) {
      return reply.code(412).send({ error: 'no_key', message: '请先填写 API Key' });
    }

    try {
      const models = await fetchModels(url, key, AbortSignal.timeout(30_000));
      return { ok: true, models, count: models.length };
    } catch (e) {
      return reply.code(502).send({ error: 'upstream_error', message: (e as Error).message });
    }
  });

  /** 图片模型配置（保持单套） */
  app.put('/api/settings/image', async (req, reply) => {
    const parsed = imageSettingsInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_input',
        message: '参数校验失败',
        details: parsed.error.flatten(),
      });
    }
    const cur = getImageConfig();
    const next: ImageProviderConfig = {
      baseUrl: parsed.data.baseUrl,
      model: parsed.data.model,
      apiKey: resolveSecret(parsed.data.apiKey, cur.apiKey),
    };
    setImageConfig(next);
    return { ok: true };
  });

  /** 用当前生效配置发一个极小的请求，验证整条链路 */
  app.post('/api/settings/test', async (_req, reply) => {
    const id = getActiveProfileId();
    const p = id ? getProfile(id) : null;
    if (!p || !p.apiKey) {
      return reply
        .code(412)
        .send({ error: 'not_configured', message: '当前配置还没填 API Key' });
    }
    try {
      const { complete } = await import('../ai/client.js');
      const out = await complete(toProviderConfig(p), [
        { role: 'user', content: '回复两个字：可用' },
      ]);
      return { ok: true, sample: out.slice(0, 50), profile: p.name };
    } catch (e) {
      return reply.code(502).send({ error: 'upstream_error', message: (e as Error).message });
    }
  });
}
