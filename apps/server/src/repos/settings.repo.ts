import type { AiProviderConfig, ID, ImageProviderConfig, ModelProfile } from '@novelforge/shared';
import { getDb, newId, nowIso } from '../db.js';

/** 库里存的样子：带真实 apiKey */
interface StoredProfile extends ModelProfile {
  apiKey: string;
}

const PROFILES_KEY = 'profiles';
const ACTIVE_KEY = 'activeProfileId';

/** 首次使用时给一个可填的默认配置，省得从空白开始 */
const DEFAULT_PROFILE: Omit<StoredProfile, 'id' | 'createdAt' | 'updatedAt'> = {
  name: 'DeepSeek',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  temperature: 0.85,
  maxTokens: 4096,
};

// ───────────────────────── 底层读写 ─────────────────────────

function readRaw<T>(key: string): T | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: unknown): void {
  getDb()
    .prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .run(key, JSON.stringify(value));
}

// ───────────────────────── 配置列表 ─────────────────────────

/**
 * 读取所有配置。
 * 第一次运行时会把旧版单套配置（settings.text）迁移成一条配置，
 * 这样老用户升级后不用重新填 Key。
 */
export function getProfiles(): StoredProfile[] {
  const stored = readRaw<StoredProfile[]>(PROFILES_KEY);
  if (stored && Array.isArray(stored)) return stored;

  const migrated = migrateLegacy();
  writeRaw(PROFILES_KEY, migrated);
  if (!getActiveProfileId() && migrated.length > 0) {
    setActiveProfileId(migrated[0]!.id);
  }
  return migrated;
}

function migrateLegacy(): StoredProfile[] {
  const legacy = readRaw<AiProviderConfig | null>('text');
  const ts = nowIso();
  const base = { ...DEFAULT_PROFILE, createdAt: ts, updatedAt: ts };

  if (legacy && (legacy.baseUrl || legacy.apiKey || legacy.model)) {
    return [
      {
        ...base,
        id: newId(),
        name: '默认模型',
        baseUrl: legacy.baseUrl || DEFAULT_PROFILE.baseUrl,
        apiKey: legacy.apiKey || '',
        model: legacy.model || DEFAULT_PROFILE.model,
        temperature: legacy.temperature ?? DEFAULT_PROFILE.temperature,
        maxTokens: legacy.maxTokens ?? DEFAULT_PROFILE.maxTokens,
      },
    ];
  }

  return [{ ...base, id: newId() }];
}

export function saveProfiles(list: StoredProfile[]): void {
  writeRaw(PROFILES_KEY, list);
}

export function getProfile(id: ID): StoredProfile | null {
  return getProfiles().find((p) => p.id === id) ?? null;
}

export function createProfile(
  input: Omit<StoredProfile, 'id' | 'createdAt' | 'updatedAt'>,
): StoredProfile {
  const list = getProfiles();
  const ts = nowIso();
  const created: StoredProfile = { ...input, id: newId(), createdAt: ts, updatedAt: ts };
  list.push(created);
  saveProfiles(list);
  // 第一个配置自动设为当前
  if (!getActiveProfileId()) setActiveProfileId(created.id);
  return created;
}

export function updateProfile(
  id: ID,
  patch: Partial<Omit<StoredProfile, 'id' | 'createdAt'>>,
): StoredProfile | null {
  const list = getProfiles();
  const idx = list.findIndex((p) => p.id === id);
  if (idx < 0) return null;
  const next: StoredProfile = { ...list[idx]!, ...patch, updatedAt: nowIso() };
  list[idx] = next;
  saveProfiles(list);
  return next;
}

export function deleteProfile(id: ID): boolean {
  const list = getProfiles();
  const next = list.filter((p) => p.id !== id);
  if (next.length === list.length) return false;
  saveProfiles(next);
  if (getActiveProfileId() === id) {
    setActiveProfileId(next[0]?.id ?? null);
  }
  return true;
}

// ───────────────────────── 当前生效 ─────────────────────────

export function getActiveProfileId(): ID | null {
  return readRaw<ID | null>(ACTIVE_KEY) ?? null;
}

export function setActiveProfileId(id: ID | null): void {
  writeRaw(ACTIVE_KEY, id);
}

/** 当前生效的完整配置（含真实 Key），供模型调用使用 */
export function getActiveProfile(): StoredProfile | null {
  const id = getActiveProfileId();
  const list = getProfiles();
  const found = id ? list.find((p) => p.id === id) : null;
  return found ?? list[0] ?? null;
}

/** 转成模型客户端需要的结构 */
export function toProviderConfig(p: StoredProfile): AiProviderConfig {
  return {
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    model: p.model,
    temperature: p.temperature,
    maxTokens: p.maxTokens,
  };
}

// ───────────────────────── 图片配置（保持单套） ─────────────────────────

const DEFAULT_IMAGE: ImageProviderConfig = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-image-1',
};

export function getImageConfig(): ImageProviderConfig {
  return readRaw<ImageProviderConfig>('image') ?? DEFAULT_IMAGE;
}

export function setImageConfig(cfg: ImageProviderConfig): void {
  writeRaw('image', cfg);
}

// ───────────────────────── Key 处理 ─────────────────────────

/** 只显示前 3 后 4 位 */
export function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 3)}••••${key.slice(-4)}`;
}

/**
 * 决定最终保存的 Key：
 * - undefined（字段未提交）→ 保留原值
 * - 含打码符（前端回显）→ 保留原值
 * - 空串 → 用户主动清空
 * - 其他 → 当作新 Key
 */
export function resolveSecret(incoming: string | undefined, current: string): string {
  if (incoming === undefined) return current;
  if (incoming.includes('••••')) return current;
  return incoming;
}

export type { StoredProfile };
