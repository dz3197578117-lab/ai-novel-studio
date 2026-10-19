import type { FastifyInstance } from 'fastify';
import type { ModelProfilePublic } from '@novelforge/shared';
import {
  DSH_DEFAULT_MODEL,
  DSH_DEEPSEEK_BASE_URL,
  readDshKey,
  readDshStatus,
} from '../repos/dsh.js';
import {
  createProfile,
  getProfile,
  getProfiles,
  maskKey,
  setActiveProfileId,
} from '../repos/settings.repo.js';

export async function dshRoutes(app: FastifyInstance): Promise<void> {
  /** 探测本机 DSH 是否已登录 DeepSeek，以及可导入哪些 Key（Key 只回打码值） */
  app.get('/api/dsh/status', async () => readDshStatus());

  /**
   * 一键导入：把 DSH 的 DeepSeek Key 复制成 NovelForge 的一套模型配置并设为当前。
   * 不修改 DSH 的任何文件。
   */
  app.post('/api/dsh/import', async (req, reply) => {
    const body = req.body as { keyName?: string } | undefined;
    const picked = readDshKey(body?.keyName);
    if (!picked) {
      return reply.code(404).send({
        error: 'not_found',
        message:
          '没有在 DeepSeek Harness 里找到可用的 API Key。请先在 DSH 里登录 DeepSeek，或手动添加配置。',
      });
    }

    // 已经导入过就不重复创建
    const existing = getProfiles().find(
      (p) => p.name === 'DeepSeek（DSH 内置）',
    );
    let profileId: string;
    if (existing) {
      profileId = existing.id;
    } else {
      const created = createProfile({
        name: 'DeepSeek（DSH 内置）',
        baseUrl: DSH_DEEPSEEK_BASE_URL,
        apiKey: picked.key,
        model: DSH_DEFAULT_MODEL,
        temperature: 0.85,
        maxTokens: 8192,
      });
      profileId = created.id;
    }

    // 设为当前
    setActiveProfileId(profileId);
    const saved = getProfile(profileId)!;

    const pub: ModelProfilePublic = {
      id: saved.id,
      name: saved.name,
      baseUrl: saved.baseUrl,
      model: saved.model,
      temperature: saved.temperature,
      maxTokens: saved.maxTokens,
      apiKeyMasked: maskKey(saved.apiKey),
      hasApiKey: Boolean(saved.apiKey),
      createdAt: saved.createdAt,
      updatedAt: saved.updatedAt,
    };
    return { profile: pub, sourceKey: picked.name, reused: Boolean(existing) };
  });
}
