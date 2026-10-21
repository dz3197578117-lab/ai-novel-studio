import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';

/**
 * 设置里的密钥静态加密。
 *
 * 为什么必须做：数据库备份是整库 VACUUM INTO，settings 表里的 API Key
 * 会原样进备份。用户把 data/ 或某个备份发出去，Key 就跟着泄露了。
 *
 * 密钥文件放在数据目录的**上一级**，这样 `data/backups/*.db` 里只有密文，
 * 单发备份不会连密钥一起给出去。代价是换机器/丢密钥后需要重新填 Key。
 */
const PREFIX = 'enc:v1:';
let cachedKey: Buffer | null = null;

function keyFile(): string {
  return (
    process.env.NOVELFORGE_KEY_FILE ??
    path.join(path.dirname(DATA_DIR), '.novelforge-key')
  );
}

function loadKey(): Buffer {
  if (cachedKey) return cachedKey;

  // 允许用环境变量带外提供密钥（多机同步/容器场景），优先于本地文件
  const fromEnv = process.env.NOVELFORGE_KEY;
  if (fromEnv) {
    cachedKey = crypto.createHash('sha256').update(fromEnv, 'utf8').digest();
    return cachedKey;
  }

  const file = keyFile();
  try {
    const buf = fs.readFileSync(file);
    if (buf.length === 32) {
      cachedKey = buf;
      return buf;
    }
  } catch {
    /* 首次运行还没有密钥文件 */
  }

  const key = crypto.randomBytes(32);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, key, { mode: 0o600 });
  } catch (e) {
    // 写不了就退化为进程内密钥：本次运行可用，但重启后旧密文解不开。
    // 不能因为密钥文件写失败就让整个应用起不来。
    console.warn('[secrets] 无法写入密钥文件，本次运行使用临时密钥:', (e as Error).message);
  }
  cachedKey = key;
  return key;
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

/** 加密任意长度的字符串；空串/已加密值原样返回，避免二次加密 */
export function encryptSecret(plain: string): string {
  if (!plain || isEncrypted(plain)) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', loadKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, enc]).toString('base64');
}

/**
 * 解密。解不开时返回空串而不是抛错：
 * 换机器/丢密钥后，用户重新填一次 Key 即可，不能让设置页整个打不开。
 */
export function decryptSecret(value: string): string {
  if (!value || !isEncrypted(value)) return value;
  try {
    const raw = Buffer.from(value.slice(PREFIX.length), 'base64');
    if (raw.length < 28) return '';
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const data = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', loadKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch (e) {
    console.warn('[secrets] 密钥解密失败（可能换了机器或密钥文件丢失）:', (e as Error).message);
    return '';
  }
}
