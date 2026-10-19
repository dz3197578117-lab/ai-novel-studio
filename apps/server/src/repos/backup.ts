import fs from 'node:fs';
import path from 'node:path';
import { DB_PATH, DATA_DIR } from '../config.js';
import { getDb } from '../db.js';

const BACKUP_DIR = path.join(DATA_DIR, 'backups');
/** 数据库自动备份间隔 */
const AUTO_BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 小时
/** 最多保留多少个数据库备份 */
const MAX_DB_BACKUPS = 10;
/** 删除留档最多保留多少个文件 */
const MAX_TRASH_RECORDS = 2000;

function ensureDir(): void {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * 备份整个数据库。
 *
 * 必须用 `VACUUM INTO`：数据库跑在 WAL 模式，直接 copyFile 只会拿到主库文件，
 * 而最近的数据几乎都在 -wal 里 —— 拷出来的备份会「看起来有表但一条数据都没有」。
 * VACUUM INTO 会写出一份包含全部已提交数据的完整快照。
 */
function snapshotTo(target: string): boolean {
  try {
    const db = getDb();
    // VACUUM INTO 要求目标文件不存在
    if (fs.existsSync(target)) fs.rmSync(target, { force: true });
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    return true;
  } catch (e) {
    console.warn('[backup] VACUUM INTO 失败，改用 checkpoint + 拷贝:', (e as Error).message);
    try {
      const db = getDb();
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      fs.copyFileSync(DB_PATH, target);
      return true;
    } catch (e2) {
      console.warn('[backup] 备份失败:', (e2 as Error).message);
      return false;
    }
  }
}

/**
 * 定期把整个数据库备份一份。
 * 之前发生过作品被删后无从恢复的情况，这是在数据库层面的兜底。
 */
export function autoBackupIfDue(force = false): void {
  try {
    ensureDir();
    const files = fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith('db-') && f.endsWith('.db'))
      .map((f) => ({ f, mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);

    const latest = files[0];
    if (!force && latest && Date.now() - latest.mtime < AUTO_BACKUP_INTERVAL_MS) {
      return;
    }
    if (!fs.existsSync(DB_PATH)) return;

    const target = path.join(BACKUP_DIR, `db-${stamp()}.db`);
    if (!snapshotTo(target)) return;
    console.log(
      `[backup] 已备份数据库 → ${path.basename(target)}（${(fs.statSync(target).size / 1024).toFixed(0)} KB）`,
    );

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

/**
 * 批量删除前留档：整批写成**一个**文件。
 *
 * 之前每章写一个文件，一次删 300 章就产生 300 个文件，
 * 上限一挤，最早删的那批（往往正是最早的章节）就被清理掉了。
 */
export function archiveDeletedBatch(kind: string, items: unknown[], meta: Record<string, unknown> = {}): string | null {
  try {
    ensureDir();
    const file = path.join(BACKUP_DIR, `deleted-${kind}-batch-${stamp()}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify({ deletedAt: new Date().toISOString(), ...meta, count: items.length, items }, null, 2),
      'utf8',
    );
    return file;
  } catch (e) {
    console.warn('[backup] 批量留档失败:', (e as Error).message);
    return null;
  }
}

/** 启动时立刻做一次备份（总是覆盖，避免上一份是旧逻辑产生的空备份） */
export function startAutoBackup(): void {
  autoBackupIfDue(true);
  const timer = setInterval(() => autoBackupIfDue(), AUTO_BACKUP_INTERVAL_MS);
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
