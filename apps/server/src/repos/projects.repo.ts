import type { Project, ProjectStatus, ID } from '@novelforge/shared';
import { getDb, newId, nowIso } from '../db.js';

interface ProjectRow {
  id: string;
  title: string;
  logline: string;
  genre: string;
  target_words: number;
  status: ProjectStatus;
  style_guide: string;
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

export interface ProjectInput {
  title: string;
  logline?: string;
  genre?: string;
  targetWords?: number;
  status?: ProjectStatus;
  styleGuide?: string;
}

export function createProject(input: ProjectInput): Project {
  const db = getDb();
  const id = newId();
  const ts = nowIso();
  db.prepare(
    `INSERT INTO projects (id, title, logline, genre, target_words, status, style_guide, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    input.title,
    input.logline ?? '',
    input.genre ?? '',
    input.targetWords ?? 0,
    input.status ?? 'drafting',
    input.styleGuide ?? '',
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
      `UPDATE projects SET title=?, logline=?, genre=?, target_words=?, status=?, style_guide=?, updated_at=? WHERE id=?`,
    )
    .run(
      patch.title ?? cur.title,
      patch.logline ?? cur.logline,
      patch.genre ?? cur.genre,
      patch.targetWords ?? cur.targetWords,
      patch.status ?? cur.status,
      patch.styleGuide ?? cur.styleGuide,
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
