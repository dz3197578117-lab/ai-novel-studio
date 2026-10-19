import type { Project, ProjectOverview, ProjectStatus, ID } from '@novelforge/shared';
import { getDb, newId, nowIso } from '../db.js';

interface ProjectRow {
  id: string;
  title: string;
  logline: string;
  genre: string;
  target_words: number;
  status: ProjectStatus;
  style_guide: string;
  brainstorm: string | null;
  created_at: string;
  updated_at: string;
}

function toProject(r: ProjectRow): Project {
  return {
    id: r.id,
    title: r.title,
    logline: r.logline,
    genre: r.genre,
    targetWords: r.target_words,
    status: r.status,
    styleGuide: r.style_guide,
    brainstorm: r.brainstorm ?? '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listProjects(): Project[] {
  const rows = getDb()
    .prepare('SELECT * FROM projects ORDER BY updated_at DESC')
    .all() as unknown as ProjectRow[];
  return rows.map(toProject);
}

export function getProject(id: ID): Project | null {
  const row = getDb().prepare('SELECT * FROM projects WHERE id = ?').get(id) as
    | ProjectRow
    | undefined;
  return row ? toProject(row) : null;
}

/**
 * 作品库列表：一次查询带出章节数、总字数、设定数与封面，
 * 避免前端为每个作品再发 N 个请求。
 */
export function listProjectsOverview(): ProjectOverview[] {
  const rows = getDb()
    .prepare(
      `SELECT
         p.*,
         (SELECT COUNT(*) FROM chapters c WHERE c.project_id = p.id) AS chapter_count,
         (SELECT COALESCE(SUM(c.word_count), 0) FROM chapters c WHERE c.project_id = p.id) AS word_count,
         (SELECT COUNT(*) FROM entities e WHERE e.project_id = p.id) AS entity_count,
         (SELECT i.url FROM images i WHERE i.project_id = p.id AND i.kind = 'cover'
            ORDER BY i.created_at DESC LIMIT 1) AS cover_url
       FROM projects p
       ORDER BY p.updated_at DESC`,
    )
    .all() as unknown as (ProjectRow & {
    chapter_count: number;
    word_count: number;
    entity_count: number;
    cover_url: string | null;
  })[];

  return rows.map((r) => ({
    ...toProject(r),
    chapterCount: r.chapter_count,
    wordCount: r.word_count,
    entityCount: r.entity_count,
    coverUrl: r.cover_url,
  }));
}

export interface ProjectInput {
  title: string;
  logline?: string;
  genre?: string;
  targetWords?: number;
  status?: ProjectStatus;
  styleGuide?: string;
  brainstorm?: string;
}

export function createProject(input: ProjectInput): Project {
  const db = getDb();
  const id = newId();
  const ts = nowIso();
  db.prepare(
    `INSERT INTO projects (id, title, logline, genre, target_words, status, style_guide, brainstorm, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    input.title,
    input.logline ?? '',
    input.genre ?? '',
    input.targetWords ?? 0,
    input.status ?? 'drafting',
    input.styleGuide ?? '',
    input.brainstorm ?? '',
    ts,
    ts,
  );
  return getProject(id)!;
}

export function updateProject(id: ID, patch: Partial<ProjectInput>): Project | null {
  const cur = getProject(id);
  if (!cur) return null;
  getDb()
    .prepare(
      `UPDATE projects SET title=?, logline=?, genre=?, target_words=?, status=?, style_guide=?, brainstorm=?, updated_at=? WHERE id=?`,
    )
    .run(
      patch.title ?? cur.title,
      patch.logline ?? cur.logline,
      patch.genre ?? cur.genre,
      patch.targetWords ?? cur.targetWords,
      patch.status ?? cur.status,
      patch.styleGuide ?? cur.styleGuide,
      patch.brainstorm ?? cur.brainstorm ?? '',
      nowIso(),
      id,
    );
  return getProject(id);
}

export function deleteProject(id: ID): boolean {
  const res = getDb().prepare('DELETE FROM projects WHERE id = ?').run(id);
  return Number(res.changes) > 0;
}

export function touchProject(id: ID): void {
  getDb().prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(nowIso(), id);
}
