import type { Entity, EntityType, ID } from '@novelforge/shared';
import { getDb, newId, nowIso } from '../db.js';

interface EntityRow {
  id: string;
  project_id: string;
  type: EntityType;
  name: string;
  aliases: string;
  summary: string;
  fields: string;
  body: string;
  pinned: number;
  created_at: string;
  updated_at: string;
}

function toEntity(row: EntityRow): Entity {
  return {
    id: row.id,
    projectId: row.project_id,
    type: row.type,
    name: row.name,
    aliases: safeArr(row.aliases),
    summary: row.summary,
    fields: safeArr(row.fields),
    body: row.body,
    pinned: row.pinned === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeArr<T>(raw: string): T[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

export function listEntities(projectId: ID, type?: EntityType): Entity[] {
  const db = getDb();
  const rows = type
    ? (db
        .prepare('SELECT * FROM entities WHERE project_id = ? AND type = ? ORDER BY name')
        .all(projectId, type) as unknown as EntityRow[])
    : (db
        .prepare('SELECT * FROM entities WHERE project_id = ? ORDER BY type, name')
        .all(projectId) as unknown as EntityRow[]);
  return rows.map(toEntity);
}

export function getEntity(id: ID): Entity | null {
  const row = getDb().prepare('SELECT * FROM entities WHERE id = ?').get(id) as
    | EntityRow
    | undefined;
  return row ? toEntity(row) : null;
}

export interface EntityInput {
  type: EntityType;
  name: string;
  aliases?: string[];
  summary?: string;
  fields?: { key: string; value: string }[];
  body?: string;
  pinned?: boolean;
}

export function createEntity(projectId: ID, input: EntityInput): Entity {
  const db = getDb();
  const id = newId();
  const ts = nowIso();
  db.prepare(
    `INSERT INTO entities (id, project_id, type, name, aliases, summary, fields, body, pinned, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    projectId,
    input.type,
    input.name,
    JSON.stringify(input.aliases ?? []),
    input.summary ?? '',
    JSON.stringify(input.fields ?? []),
    input.body ?? '',
    input.pinned ? 1 : 0,
    ts,
    ts,
  );
  return getEntity(id)!;
}

export function updateEntity(id: ID, patch: Partial<EntityInput>): Entity | null {
  const existing = getEntity(id);
  if (!existing) return null;
  const db = getDb();
  db.prepare(
    `UPDATE entities SET type=?, name=?, aliases=?, summary=?, fields=?, body=?, pinned=?, updated_at=? WHERE id=?`,
  ).run(
    patch.type ?? existing.type,
    patch.name ?? existing.name,
    JSON.stringify(patch.aliases ?? existing.aliases),
    patch.summary ?? existing.summary,
    JSON.stringify(patch.fields ?? existing.fields),
    patch.body ?? existing.body,
    (patch.pinned ?? existing.pinned) ? 1 : 0,
    nowIso(),
    id,
  );
  return getEntity(id);
}

export function deleteEntity(id: ID): boolean {
  const res = getDb().prepare('DELETE FROM entities WHERE id = ?').run(id);
  return Number(res.changes) > 0;
}

/** 取所有 pinned 设定，用于注入生成上下文 */
export function listPinnedEntities(projectId: ID): Entity[] {
  const rows = getDb()
    .prepare('SELECT * FROM entities WHERE project_id = ? AND pinned = 1 ORDER BY type, name')
    .all(projectId) as unknown as EntityRow[];
  return rows.map(toEntity);
}
