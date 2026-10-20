import type { ID, IssueSeverity, WritingConstraint } from '@novelforge/shared';
import { getDb, newId, nowIso, transaction } from '../db.js';

interface ConstraintRow {
  id: string;
  project_id: string;
  chapter_id: string | null;
  text: string;
  severity: IssueSeverity;
  status: 'open' | 'resolved';
  created_at: string;
  updated_at: string;
}

const toConstraint = (r: ConstraintRow): WritingConstraint => ({
  id: r.id,
  projectId: r.project_id,
  chapterId: r.chapter_id,
  text: r.text,
  severity: r.severity,
  status: r.status,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function listConstraints(
  projectId: ID,
  status: 'open' | 'resolved' | 'all' = 'open',
  limit = 30,
): WritingConstraint[] {
  const sql =
    status === 'all'
      ? `SELECT * FROM writing_constraints WHERE project_id = ?
         ORDER BY created_at DESC LIMIT ?`
      : `SELECT * FROM writing_constraints WHERE project_id = ? AND status = ?
         ORDER BY created_at DESC LIMIT ?`;
  const params = status === 'all' ? [projectId, limit] : [projectId, status, limit];
  const rows = getDb()
    .prepare(sql)
    .all(...params) as unknown as ConstraintRow[];
  return rows.map(toConstraint);
}

/** 注入生成上下文的约束：只取未解决的，最多 8 条 */
export function listOpenConstraints(projectId: ID, limit = 8): WritingConstraint[] {
  return listConstraints(projectId, 'open', limit);
}

/**
 * 批量写入约束，按文本去重。
 * 同一条问题重复检查多次不应该堆成 10 条相同提醒。
 */
export function addConstraints(
  projectId: ID,
  chapterId: ID | null,
  items: { text: string; severity?: IssueSeverity }[],
): number {
  const db = getDb();
  const existing = new Set(
    (
      db
        .prepare(
          `SELECT text FROM writing_constraints WHERE project_id = ? AND status = 'open'`,
        )
        .all(projectId) as { text: string }[]
    ).map((r) => r.text),
  );

  const fresh = items
    .map((i) => ({ text: i.text.trim(), severity: i.severity ?? 'high' }))
    .filter((i) => i.text.length > 0 && !existing.has(i.text));

  if (fresh.length === 0) return 0;

  const stmt = db.prepare(
    `INSERT INTO writing_constraints (id, project_id, chapter_id, text, severity, status, created_at, updated_at)
     VALUES (?,?,?,?,?, 'open', ?, ?)`,
  );
  const ts = nowIso();
  transaction(() => {
    for (const f of fresh) {
      stmt.run(newId(), projectId, chapterId, f.text.slice(0, 500), f.severity, ts, ts);
    }
  });
  return fresh.length;
}

export function setConstraintStatus(id: ID, status: 'open' | 'resolved'): boolean {
  const res = getDb()
    .prepare('UPDATE writing_constraints SET status=?, updated_at=? WHERE id=?')
    .run(status, nowIso(), id);
  return Number(res.changes) > 0;
}

export function deleteConstraint(id: ID): boolean {
  const res = getDb().prepare('DELETE FROM writing_constraints WHERE id=?').run(id);
  return Number(res.changes) > 0;
}

/** 清掉所有已解决的约束记录 */
export function clearResolvedConstraints(projectId: ID): number {
  const res = getDb()
    .prepare(`DELETE FROM writing_constraints WHERE project_id = ? AND status = 'resolved'`)
    .run(projectId);
  return Number(res.changes);
}
