import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * 复用 DeepSeek Harness（DSH）本机已登录的 DeepSeek 凭据。
 *
 * 只读：绝不修改 DSH 的任何文件；导入后 Key 存进 NovelForge 自己的数据库。
 * DSH 的凭据文件是 YAML，结构简单，这里用逐行解析，不引额外依赖。
 */

export interface DshKeyInfo {
  /** refs 里的名字，如 DEEPSEEK_API_KEY */
  name: string;
  /** 打码后的值，仅用于展示 */
  masked: string;
}

export interface DshStatus {
  available: boolean;
  /** 凭据文件路径（便于用户核对） */
  home: string;
  keys: DshKeyInfo[];
  /** 推荐导入的 key 名；没有则为 null */
  recommended: string | null;
  /** 是否有 DSH 账号 token（不一定能用于 API，仅作提示） */
  hasAccountToken: boolean;
}

function dshHome(): string {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function credentialsPath(): string {
  return path.join(dshHome(), '.credentials.yaml');
}

function mask(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 3)}••••${key.slice(-4)}`;
}

/** 解析 .credentials.yaml 里我们关心的两部分：refs 与 deepseek 账号 token */
export function parseCredentials(text: string): {
  refs: Record<string, string>;
  hasAccountToken: boolean;
} {
  const refs: Record<string, string> = {};
  let hasAccountToken = false;
  let inRefs = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line || line.trimStart().startsWith('#')) continue;

    if (/^refs:\s*$/.test(line)) {
      inRefs = true;
      continue;
    }
    // 顶层 key（无缩进且以 : 结尾）结束 refs 段
    if (inRefs && /^[A-Za-z_]/.test(line)) {
      inRefs = false;
    }

    if (inRefs) {
      const m = /^\s+([A-Z0-9_]+):\s*(.+)$/.exec(line);
      if (m) refs[m[1]!] = m[2]!.trim();
      continue;
    }

    if (/deepseek-account-platform\/default:/.test(line)) hasAccountToken = true;
  }

  return { refs, hasAccountToken };
}

export function readDshStatus(): DshStatus {
  const home = dshHome();
  const file = credentialsPath();
  if (!fs.existsSync(file)) {
    return { available: false, home, keys: [], recommended: null, hasAccountToken: false };
  }
  try {
    const { refs, hasAccountToken } = parseCredentials(fs.readFileSync(file, 'utf8'));
    const keys = Object.entries(refs)
      .filter(([name]) => /API_KEY$/.test(name))
      .map(([name, value]) => ({ name, masked: mask(value) }));

    // 优先 DeepSeek 官方 key
    const recommended =
      keys.find((k) => k.name === 'DEEPSEEK_API_KEY')?.name ?? keys[0]?.name ?? null;

    return { available: true, home, keys, recommended, hasAccountToken };
  } catch {
    return { available: false, home, keys: [], recommended: null, hasAccountToken: false };
  }
}

/** 取指定名字的原始 Key；未指定时用推荐项 */
export function readDshKey(name?: string): { name: string; key: string } | null {
  const file = credentialsPath();
  if (!fs.existsSync(file)) return null;
  try {
    const { refs } = parseCredentials(fs.readFileSync(file, 'utf8'));
    const target = name ?? (refs.DEEPSEEK_API_KEY ? 'DEEPSEEK_API_KEY' : Object.keys(refs)[0]);
    if (!target || !refs[target]) return null;
    return { name: target, key: refs[target]! };
  } catch {
    return null;
  }
}

/** DSH 用的 DeepSeek 官方接口地址与可用模型（实测 202-10 可用 deepseek-flash / deepseek-v4-pro） */
export const DSH_DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';
export const DSH_DEFAULT_MODEL = 'deepseek-flash';
