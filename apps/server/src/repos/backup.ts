import fs from 'node:fs';
import path from 'node:path';
import { DB_PATH, DATA_DIR } from '../config.js';

const BACKUP_DIR = path.join(DATA_DIR, 'backups');
/** 数据库自动备份间隔 */
const AUTO_BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 小时
/** 最多保留多少个数据库备份 */
const MAX_DB_BACKUPS = 10;
/** 删除留档最多保留多少个 */
const MAX_TRASH_RECORDS = 200;

function ensureDir(): void {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * 定期把整个数据库复制一份。
 * 之前发生过作品被删后无从恢复的情况，这是在数据库层面的兜底。
 */
export function autoBackupIfDue(): void {
  try {
    ensureDir();
    const files = fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith('db-') && f.endsWith('.db'))
      .map((f) => ({ f, mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);

    const latest = files[0];
    if (latest && Date.now() - latest.mtime < AUTO_BACKUP_INTERVAL_MS) {
      return;
    }
    if (!fs.existsSync(DB_PATH)) return;

    const target = path.join(BACKUP_DIR, `db-${stamp()}.db`);
    fs.copyFileSync(DB_PATH, target);
    console.log(`[backup] 已备份数据库 → ${path.basename(target)}`);

    // 清理旧备份
    const all = fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith('db-') && f.endsWith('.db'))
      .map((f) => ({ f, mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const old of all.slice(MAX_DB_BACKUPS)) {
      fs.rmSync(path.join(BACKUP_DIR, old.f), { force: true });
    }
  } catch (e) {
    console.warn('[backup] 自动备份失败:', (e as Error).message);
  }
}

/**
 * 删除作品/章节前，把内容完整存成 JSON。
 * 这样误删还能从 backups/ 里找回来。
 */
export function archiveDeleted(kind: 'project' | 'chapter' | 'volume', payload: unknown): string | null {
  try {
    ensureDir();
    const file = path.join(BACKUP_DIR, `deleted-${kind}-${stamp()}.json`);
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');

    const records = fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith('deleted-'))
      .map((f) => ({ f, mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const old of records.slice(MAX_TRASH_RECORDS)) {
      fs.rmSync(path.join(BACKUP_DIR, old.f), { force: true });
    }
    return file;
  } catch (e) {
    console.warn('[backup] 删除留档失败:', (e as Error).message);
    return null;
  }
}

/** 启动时立刻做一次备份（间隔未到则跳过） */
export function startAutoBackup(): void {
  autoBackupIfDue();
  const timer = setInterval(autoBackupIfDue, AUTO_BACKUP_INTERVAL_MS);
  timer.unref?.();
}

export function listBackups(): { file: string; size: number; mtime: string }[] {
  ensureDir();
  return fs
    .readdirSync(BACKUP_DIR)
    .map((f) => {
      const st = fs.statSync(path.join(BACKUP_DIR, f));
      return { file: f, size: st.size, mtime: st.mtime.toISOString() };
    })
    .sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
}
