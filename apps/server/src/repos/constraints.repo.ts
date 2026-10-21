import type { ID, IssueSeverity, WritingConstraint } from '@novelforge/shared';
import { getDb, newId, nowIso, transaction } from '../db.js';

interface ConstraintRow {
  id: string;
  project_id: string;
  chapter_id: string | null;
  text: string;
  severity: IssueSeverity;
  status: 'open' | 'resolved';
  apply_from_order: number | null;
  expires_at: string | null;
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
  applyFromOrder: r.apply_from_order,
  expiresAt: r.expires_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** 默认 90 天后不再注入：半年前的问题不该一直占着上下文 */
const DEFAULT_TTL_DAYS = 90;

/** 把过期的未解决约束标成 resolved */
function expireOld(projectId: ID): void {
  getDb()
    .prepare(
      `UPDATE writing_constraints SET status = 'resolved', updated_at = ?
       WHERE project_id = ? AND status = 'open'
         AND expires_at IS NOT NULL AND expires_at <= ?`,
    )
    .run(nowIso(), projectId, nowIso());
}

export function listConstraints(
  projectId: ID,
  status: 'open' | 'resolved' | 'all' = 'open',
  limit = 30,
  opts: { maxOrder?: number } = {},
): WritingConstraint[] {
  expireOld(projectId);

  const orderFilter =
    opts.maxOrder === undefined
      ? ''
      : ' AND (apply_from_order IS NULL OR apply_from_order <= ?)';
  const base =
    status === 'all'
      ? `SELECT * FROM writing_constraints WHERE project_id = ?${orderFilter}`
      : `SELECT * FROM writing_constraints WHERE project_id = ? AND status = ?${orderFilter}`;

  const sql = `${base} ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, created_at DESC LIMIT ?`;
  const params: unknown[] =
    status === 'all' ? [projectId] : [projectId, status];
  if (opts.maxOrder !== undefined) params.push(opts.maxOrder);
  params.push(limit);

  const rows = getDb()
    .prepare(sql)
    .all(...(params as never[])) as unknown as ConstraintRow[];
  return rows.map(toConstraint);
}

/**
 * 注入生成上下文的约束。
 * chapterOrder 传入当前章节的 order：只取「已经生效」的约束，
 * 避免重写第 3 章时收到第 50 章才发现的问题。
 */
export function listOpenConstraints(
  projectId: ID,
  limit = 8,
  chapterOrder?: number,
): WritingConstraint[] {
  return listConstraints(projectId, 'open', limit, { maxOrder: chapterOrder });
}

/**
 * 批量写入约束，按文本去重。
 * 同一条问题重复检查多次不应该堆成 10 条相同提醒。
 */
export function addConstraints(
  projectId: ID,
  chapterId: ID | null,
  items: { text: string; severity?: IssueSeverity }[],
  opts: { applyFromOrder?: number | null; ttlDays?: number } = {},
): number {
  const db = getDb();
  // 先把过期的清掉，否则同文本的新约束会被“已过期但仍是 open”的旧记录挡住
  expireOld(projectId);
  const existing = new Set(
    (
      db
        .prepare(
          `SELECT text FROM writing_constraints WHERE project_id = ? AND status = 'open'`,
        )
        .all(projectId) as { text: string }[]
    ).map((r) => r.text),
  );

  // 同一次检查里可能出现两条一模一样的建议：既要去掉库里已有的，也要去掉本批重复的
  const seen = new Set<string>();
  const fresh = items
    .map((i) => ({ text: i.text.trim(), severity: i.severity ?? 'high' }))
    .filter((i) => {
      if (!i.text || existing.has(i.text) || seen.has(i.text)) return false;
      seen.add(i.text);
      return true;
    });

  if (fresh.length === 0) return 0;

  const stmt = db.prepare(
    `INSERT INTO writing_constraints
       (id, project_id, chapter_id, text, severity, status, apply_from_order, expires_at, created_at, updated_at)
     VALUES (?,?,?,?,?, 'open', ?, ?, ?, ?)`,
  );
  const ts = nowIso();
  const ttl = opts.ttlDays ?? DEFAULT_TTL_DAYS;
  const expiresAt = new Date(Date.now() + ttl * 24 * 60 * 60 * 1000).toISOString();

  transaction(() => {
    for (const f of fresh) {
      stmt.run(
        newId(),
        projectId,
        chapterId,
        f.text.slice(0, 500),
        f.severity,
        opts.applyFromOrder ?? null,
        expiresAt,
        ts,
        ts,
      );
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
