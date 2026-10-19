import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, DB_PATH, IMAGES_DIR, EXPORTS_DIR } from './config.js';

let db: DatabaseSync | null = null;

/**
 * 全局单例数据库。/data 下的 novelforge.db。
 * 使用 Node 内置 node:sqlite，零原生依赖，无需编译。
 */
export function getDb(): DatabaseSync {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  fs.mkdirSync(EXPORTS_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

/** 迁移：用 user_version 递增，所有建表语句集中在此，便于演进 */
function migrate(d: DatabaseSync): void {
  const row = d.prepare('PRAGMA user_version').get() as { user_version: number };
  let version = row.user_version ?? 0;

  if (version < 1) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        logline TEXT NOT NULL DEFAULT '',
        genre TEXT NOT NULL DEFAULT '',
        target_words INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'drafting',
        style_guide TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        aliases TEXT NOT NULL DEFAULT '[]',
        summary TEXT NOT NULL DEFAULT '',
        fields TEXT NOT NULL DEFAULT '[]',
        body TEXT NOT NULL DEFAULT '',
        pinned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_entities_project ON entities(project_id, type);

      CREATE TABLE IF NOT EXISTS volumes (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_volumes_project ON volumes(project_id, sort_order);

      CREATE TABLE IF NOT EXISTS chapters (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        volume_id TEXT REFERENCES volumes(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        outline TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'outline',
        word_count INTEGER NOT NULL DEFAULT 0,
        summary TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chapters_project ON chapters(project_id, sort_order);
      CREATE INDEX IF NOT EXISTS idx_chapters_volume ON chapters(volume_id, sort_order);

      CREATE TABLE IF NOT EXISTS images (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        chapter_id TEXT REFERENCES chapters(id) ON DELETE SET NULL,
        prompt TEXT NOT NULL,
        url TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'illustration',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    version = 1;
  }

  if (version < 2) {
    // 一致性引擎：伏笔台账 + 时间线
    d.exec(`
      CREATE TABLE IF NOT EXISTS foreshadows (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        planted_chapter_id TEXT REFERENCES chapters(id) ON DELETE SET NULL,
        planned_chapter_id TEXT REFERENCES chapters(id) ON DELETE SET NULL,
        recovered_chapter_id TEXT REFERENCES chapters(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'planted',
        importance INTEGER NOT NULL DEFAULT 2,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_foreshadows_project ON foreshadows(project_id, status);

      CREATE TABLE IF NOT EXISTS timeline_events (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        story_time TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        chapter_id TEXT REFERENCES chapters(id) ON DELETE SET NULL,
        importance INTEGER NOT NULL DEFAULT 2,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_timeline_project ON timeline_events(project_id);
    `);
    version = 2;
  }

  if (version < 3) {
    // 分层创作（脑暴/细纲/场景卡）+ 作者知识库
    d.exec(`
      ALTER TABLE projects ADD COLUMN brainstorm TEXT NOT NULL DEFAULT '';
      ALTER TABLE chapters ADD COLUMN beats TEXT NOT NULL DEFAULT '';

      CREATE TABLE IF NOT EXISTS scenes (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        title TEXT NOT NULL,
        pov TEXT NOT NULL DEFAULT '',
        location TEXT NOT NULL DEFAULT '',
        goal TEXT NOT NULL DEFAULT '',
        conflict TEXT NOT NULL DEFAULT '',
        outcome TEXT NOT NULL DEFAULT '',
        key_lines TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_scenes_chapter ON scenes(chapter_id, sort_order);

      CREATE TABLE IF NOT EXISTS knowledge_docs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '[]',
        content TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_project ON knowledge_docs(project_id);

      CREATE TABLE IF NOT EXISTS knowledge_chunks (
        id TEXT PRIMARY KEY,
        doc_id TEXT NOT NULL REFERENCES knowledge_docs(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        text TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_project ON knowledge_chunks(project_id);
    `);
    version = 3;
  }

  d.exec(`PRAGMA user_version = ${version}`);
}

/** 测试用：内存库 */
export function openMemoryDb(): DatabaseSync {
  const m = new DatabaseSync(':memory:');
  m.exec('PRAGMA foreign_keys = ON;');
  migrate(m);
  return m;
}

export function closeDb(): void {
  db?.close();
  db = null;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(): string {
  return crypto.randomUUID();
}

/** 粗略中英文混排字数统计 */
export function countWords(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fa5]/g) ?? []).length;
  const words = (text.match(/[A-Za-z0-9_'-]+/g) ?? []).length;
  return cjk + words;
}
