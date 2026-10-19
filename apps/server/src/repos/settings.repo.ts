import type { AiProviderConfig } from '@novelforge/shared';
import { getDb, nowIso } from '../db.js';

const DEFAULTS: Record<string, unknown> = {
  text: {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    temperature: 0.85,
    maxTokens: 4096,
  },
  image: {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-image-1',
  },
};

export function getSetting<T>(key: string, fallback: T): T {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  if (!row) return (DEFAULTS[key] as T) ?? fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export function setSetting(key: string, value: unknown): void {
  const db = getDb();
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, JSON.stringify(value));
  void nowIso;
}

export function getTextConfigRaw(): AiProviderConfig {
  return getSetting<AiProviderConfig>('text', DEFAULTS.text as AiProviderConfig);
}
