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

/** user_version 递增迁移。整体包在事务里：失败则全部回滚，不会留下半套表 */
function migrate(d: DatabaseSync): void {
  const row = d.prepare('PRAGMA user_version').get() as { user_version: number };
  let version = row.user_version ?? 0;

  d.exec('BEGIN');
  try {
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
    // 先探测列：旧版本可能执行过 ALTER 但没推进 user_version（迁移无事务时期留下的）
    if (!hasColumn(d, 'projects', 'brainstorm')) {
      d.exec(`ALTER TABLE projects ADD COLUMN brainstorm TEXT NOT NULL DEFAULT '';`);
    }
    if (!hasColumn(d, 'chapters', 'beats')) {
      d.exec(`ALTER TABLE chapters ADD COLUMN beats TEXT NOT NULL DEFAULT '';`);
    }
    d.exec(`

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

  if (version < 4) {
    // 项目级硬约束：考据规则、制度设定、写作禁令（每次生成都会注入）
    if (!hasColumn(d, 'projects', 'rules')) {
      d.exec(`ALTER TABLE projects ADD COLUMN rules TEXT NOT NULL DEFAULT '';`);
    }
    version = 4;
  }

  if (version < 5) {
    // 写前列事实清单 + 一致性检查沉淀的写作约束
    if (!hasColumn(d, 'chapters', 'facts')) {
      d.exec(`ALTER TABLE chapters ADD COLUMN facts TEXT NOT NULL DEFAULT '[]';`);
    }
    d.exec(`
      CREATE TABLE IF NOT EXISTS writing_constraints (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        chapter_id TEXT REFERENCES chapters(id) ON DELETE SET NULL,
        text TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'high',
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_constraints_project ON writing_constraints(project_id, status);
    `);
    version = 5;
  }

  if (version < 6) {
    // 项目级叙述视角：设定后每次生成注入守则，一致性检查以它为基准
    if (!hasColumn(d, 'projects', 'pov')) {
      d.exec(`ALTER TABLE projects ADD COLUMN pov TEXT NOT NULL DEFAULT 'auto';`);
    }
    if (!hasColumn(d, 'projects', 'pov_note')) {
      d.exec(`ALTER TABLE projects ADD COLUMN pov_note TEXT NOT NULL DEFAULT '';`);
    }
    version = 6;
  }

  if (version < 7) {
    // 章节级视角覆盖：空串表示继承项目默认（楔子、序章、尾声用）
    if (!hasColumn(d, 'chapters', 'pov')) {
      d.exec(`ALTER TABLE chapters ADD COLUMN pov TEXT NOT NULL DEFAULT '';`);
    }
    version = 7;
  }

  if (version < 8) {
    // 长任务落库（服务重启/关页面后仍能看到部分结果）+ 章节版本历史
    d.exec(`
      CREATE TABLE IF NOT EXISTS job_runs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'running',
        progress TEXT NOT NULL DEFAULT '{}',
        result TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_job_runs_project ON job_runs(project_id, created_at);

      CREATE TABLE IF NOT EXISTS chapter_versions (
        id TEXT PRIMARY KEY,
        chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        outline TEXT NOT NULL DEFAULT '',
        beats TEXT NOT NULL DEFAULT '',
        word_count INTEGER NOT NULL DEFAULT 0,
        reason TEXT NOT NULL DEFAULT 'autosave',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chapter_versions ON chapter_versions(chapter_id, created_at);
    `);
    version = 8;
  }

  if (version < 9) {
    // 约束按章节生效 + 过期；事实清单的引用片段落库；知识库 2-gram 倒排索引
    if (!hasColumn(d, 'writing_constraints', 'apply_from_order')) {
      d.exec(`ALTER TABLE writing_constraints ADD COLUMN apply_from_order INTEGER;`);
    }
    if (!hasColumn(d, 'writing_constraints', 'expires_at')) {
      d.exec(`ALTER TABLE writing_constraints ADD COLUMN expires_at TEXT;`);
    }
    if (!hasColumn(d, 'chapters', 'fact_sheet')) {
      d.exec(`ALTER TABLE chapters ADD COLUMN fact_sheet TEXT NOT NULL DEFAULT '{}';`);
    }
    // 旧约束没有作用域：按“当前全书末尾”回填，避免重写旧章节时被后期限定干扰
    d.exec(`
      UPDATE writing_constraints
      SET apply_from_order = (
        SELECT COALESCE(MAX(c.sort_order) + 1, 0)
        FROM chapters c WHERE c.project_id = writing_constraints.project_id
      )
      WHERE apply_from_order IS NULL;
    `);
    d.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_terms (
        project_id TEXT NOT NULL,
        term TEXT NOT NULL,
        chunk_id TEXT NOT NULL REFERENCES knowledge_chunks(id) ON DELETE CASCADE,
        PRIMARY KEY (project_id, term, chunk_id)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS idx_knowledge_terms_chunk ON knowledge_terms(chunk_id);
    `);
    version = 9;
  }

  d.exec(`PRAGMA user_version = ${version}`);
  d.exec('COMMIT');
  } catch (e) {
    try {
      d.exec('ROLLBACK');
    } catch {
      /* 回滚失败时保留原始错误 */
    }
    throw e;
  }
}

/** 列是否已存在（迁移幂等用） */
function hasColumn(d: DatabaseSync, table: string, column: string): boolean {
  const rows = d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some((r) => r.name === column);
}

/**
 * 在单个事务里执行一组写操作；抛错自动回滚。
 * 支持嵌套调用（内层直接复用外层事务）。
 */
let txDepth = 0;
export function transaction<T>(fn: () => T): T {
  if (txDepth > 0) return fn();
  const d = getDb();
  txDepth++;
  d.exec('BEGIN');
  try {
    const out = fn();
    d.exec('COMMIT');
    return out;
  } catch (e) {
    try {
      d.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw e;
  } finally {
    txDepth--;
  }
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
