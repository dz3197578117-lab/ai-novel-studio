import { useState } from 'react';
import type { Entity, EntityType } from '@novelforge/shared';
import { useNovel } from '../store/novel';
import { api } from '../api/client';
import { Modal } from './Modal';

const TYPE_LABEL: Record<EntityType, string> = {
  world: '世界观',
  character: '人物',
  faction: '势力',
  term: '名词',
  item: '物品',
  location: '地点',
};

/** 设定库管理弹窗 */
export function EntityManager({ open, onClose }: { open: boolean; onClose: () => void }) {
  const project = useNovel((s) => s.project);
  const entities = useNovel((s) => s.entities);
  const refresh = useNovel((s) => s.refresh);
  const setError = useNovel((s) => s.setError);

  const [filter, setFilter] = useState<EntityType | 'all'>('all');
  const [editing, setEditing] = useState<Entity | null>(null);
  const [creating, setCreating] = useState(false);

  const shown = filter === 'all' ? entities : entities.filter((e) => e.type === filter);

  async function remove(e: Entity) {
    if (!confirm(`删除设定「${e.name}」？`)) return;
    try {
      await api.del(`/api/entities/${e.id}`);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function togglePin(e: Entity) {
    try {
      await api.patch(`/api/entities/${e.id}`, { pinned: !e.pinned });
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (!project) return null;

  return (
    <Modal open={open} onClose={onClose} title="设定库">
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
        <button
          className={filter === 'all' ? 'primary' : ''}
          onClick={() => setFilter('all')}
          style={{ flex: 'none', padding: '4px 10px' }}
        >
          全部
        </button>
        {(Object.keys(TYPE_LABEL) as EntityType[]).map((t) => (
          <button
            key={t}
            className={filter === t ? 'primary' : ''}
            onClick={() => setFilter(t)}
            style={{ flex: 'none', padding: '4px 10px' }}
          >
            {TYPE_LABEL[t]}
          </button>
        ))}
        <button
          className="primary"
          style={{ flex: 'none', marginLeft: 'auto', padding: '4px 12px' }}
          onClick={() => {
            setEditing(null);
            setCreating(true);
          }}
        >
          ＋ 新建设定
        </button>
      </div>

      {shown.length === 0 && (
        <div className="empty">
          还没有设定。人物、世界观、势力填得越清楚，AI 写出来越不容易跑偏。
        </div>
      )}

      {shown.map((e) => (
        <div className="entity-card" key={e.id}>
          <div className="name">
            <span>
              {e.name}
              {e.aliases.length > 0 && (
                <span className="summary" style={{ marginLeft: 6 }}>
                  （{e.aliases.join('、')}）
                </span>
              )}
            </span>
            <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span className="tag">{TYPE_LABEL[e.type]}</span>
              <button
                className="ghost"
                style={{ padding: '0 4px', fontSize: 11 }}
                onClick={() => togglePin(e)}
                title={e.pinned ? '已注入上下文，点击取消' : '点击固定，注入每次生成'}
              >
                {e.pinned ? '★' : '☆'}
              </button>
            </span>
          </div>
          {e.summary && <div className="summary">{e.summary}</div>}
          {e.fields.length > 0 && (
            <div className="summary">
              {e.fields.map((f) => `${f.key}:${f.value}`).join(' · ')}
            </div>
          )}
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <button
              style={{ padding: '3px 10px', fontSize: 12 }}
              onClick={() => {
                setEditing(e);
                setCreating(true);
              }}
            >
              编辑
            </button>
            <button className="danger" style={{ padding: '3px 10px', fontSize: 12 }} onClick={() => remove(e)}>
              删除
            </button>
          </div>
        </div>
      ))}

      <EntityEditor
        open={creating}
        entity={editing}
        projectId={project.id}
        onClose={() => setCreating(false)}
        onSaved={async () => {
          setCreating(false);
          await refresh();
        }}
      />
    </Modal>
  );
}

function EntityEditor({
  open,
  entity,
  projectId,
  onClose,
  onSaved,
}: {
  open: boolean;
  entity: Entity | null;
  projectId: string;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const setError = useNovel((s) => s.setError);
  const [type, setType] = useState<EntityType>(entity?.type ?? 'character');
  const [name, setName] = useState(entity?.name ?? '');
  const [aliases, setAliases] = useState(entity?.aliases.join('、') ?? '');
  const [summary, setSummary] = useState(entity?.summary ?? '');
  const [body, setBody] = useState(entity?.body ?? '');
  const [fields, setFields] = useState(
    (entity?.fields ?? []).map((f) => `${f.key}:${f.value}`).join('\n'),
  );
  const [pinned, setPinned] = useState(entity?.pinned ?? false);
  const [busy, setBusy] = useState(false);

  // 打开时重置表单
  const [lastId, setLastId] = useState<string | null>(null);
  const key = entity?.id ?? 'new';
  if (open && lastId !== key) {
    setLastId(key);
    setType(entity?.type ?? 'character');
    setName(entity?.name ?? '');
    setAliases(entity?.aliases.join('、') ?? '');
    setSummary(entity?.summary ?? '');
    setBody(entity?.body ?? '');
    setFields((entity?.fields ?? []).map((f) => `${f.key}:${f.value}`).join('\n'));
    setPinned(entity?.pinned ?? false);
  }

  async function save() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const payload = {
        type,
        name: name.trim(),
        aliases: aliases
          .split(/[、,，\s]+/)
          .map((s) => s.trim())
          .filter(Boolean),
        summary,
        body,
        pinned,
        fields: fields
          .split('\n')
          .map((line) => {
            const i = line.indexOf(':');
            if (i < 0) return null;
            return { key: line.slice(0, i).trim(), value: line.slice(i + 1).trim() };
          })
          .filter((f): f is { key: string; value: string } => !!f?.key),
      };
      if (entity) await api.patch(`/api/entities/${entity.id}`, payload);
      else await api.post(`/api/projects/${projectId}/entities`, payload);
      await onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={entity ? '编辑设定' : '新建设定'}>
      <div className="row">
        <div className="field">
          <label>类型</label>
          <select value={type} onChange={(e) => setType(e.target.value as EntityType)}>
            {(Object.keys(TYPE_LABEL) as EntityType[]).map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>名称</label>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </div>
      </div>
      <div className="field">
        <label>别名（用顿号或逗号分隔）</label>
        <input value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder="如：尘弟、林师兄" />
      </div>
      <div className="field">
        <label>一句话摘要（注入上下文时优先用它）</label>
        <input value={summary} onChange={(e) => setSummary(e.target.value)} />
      </div>
      <div className="field">
        <label>结构化属性（每行 键:值）</label>
        <textarea
          rows={3}
          value={fields}
          onChange={(e) => setFields(e.target.value)}
          placeholder={'年龄:17\n宗门:青云宗\n性格:沉默寡言'}
        />
      </div>
      <div className="field">
        <label>详细设定</label>
        <textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)} />
      </div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
        <input
          type="checkbox"
          checked={pinned}
          onChange={(e) => setPinned(e.target.checked)}
          style={{ width: 'auto' }}
        />
        固定注入：每次 AI 生成都带上这条设定
      </label>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 18 }}>
        <button onClick={onClose}>取消</button>
        <button className="primary" onClick={save} disabled={busy || !name.trim()}>
          保存
        </button>
      </div>
    </Modal>
  );
}
