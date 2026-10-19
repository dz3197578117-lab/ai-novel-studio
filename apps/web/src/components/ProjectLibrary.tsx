import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ProjectOverview, ProjectStatus } from '@novelforge/shared';
import { useNovel } from '../store/novel';
import { api } from '../api/client';
import { Modal } from './Modal';
import { ProjectDialog } from './ProjectDialog';

const STATUS_LABEL: Record<ProjectStatus, string> = {
  drafting: '写作中',
  paused: '暂停',
  finished: '已完结',
  archived: '已归档',
};

/** 作品库：集中管理所有小说（打开 / 新建 / 编辑 / 删除） */
export function ProjectLibrary({ open, onClose }: { open: boolean; onClose: () => void }) {
  const currentProjectId = useNovel((s) => s.currentProjectId);
  const selectProject = useNovel((s) => s.selectProject);
  const loadProjects = useNovel((s) => s.loadProjects);
  const clearProject = useNovel((s) => s.clearProject);
  const setError = useNovel((s) => s.setError);

  const [items, setItems] = useState<ProjectOverview[]>([]);
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ project: ProjectOverview | null } | null>(null);

  const refresh = useCallback(async () => {
    try {
      setItems(await api.get<ProjectOverview[]>('/api/projects/overview'));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [setError]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (i) =>
        i.title.toLowerCase().includes(q) ||
        i.genre.toLowerCase().includes(q) ||
        i.logline.toLowerCase().includes(q),
    );
  }, [items, query]);

  const totalWords = items.reduce((s, i) => s + i.wordCount, 0);

  async function openProject(id: string) {
    setBusyId(id);
    try {
      await selectProject(id);
      onClose();
    } finally {
      setBusyId(null);
    }
  }

  async function remove(item: ProjectOverview) {
    const ok = confirm(
      `确定删除《${item.title}》？\n\n` +
        `将同时删除 ${item.chapterCount} 个章节、${item.entityCount} 条设定与所有配图，且无法恢复。\n\n` +
        `如果只是想暂时不写，建议改为「已归档」。`,
    );
    if (!ok) return;

    setBusyId(item.id);
    try {
      await api.del(`/api/projects/${item.id}`);
      // 删掉的正好是当前打开的作品，先解绑，再让 loadProjects 自动选下一本
      if (item.id === currentProjectId) clearProject();
      await loadProjects();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="作品库">
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, alignItems: 'center' }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索书名、题材或简介…"
          style={{ flex: 1 }}
        />
        <button
          className="primary"
          style={{ flex: 'none', whiteSpace: 'nowrap' }}
          onClick={() => setEditor({ project: null })}
        >
          ＋ 新建
        </button>
      </div>

      {items.length > 0 && (
        <div className="summary" style={{ marginBottom: 12 }}>
          共 {items.length} 部作品 · 累计 {totalWords.toLocaleString()} 字
        </div>
      )}

      {shown.length === 0 && (
        <div className="empty">
          {items.length === 0 ? (
            <>
              还没有作品
              <br />
              点上面「＋ 新建」开始你的第一部小说
            </>
          ) : (
            <>没有匹配「{query}」的作品</>
          )}
        </div>
      )}

      <div className="lib-grid">
        {shown.map((item) => (
          <div
            key={item.id}
            className={`lib-card${item.id === currentProjectId ? ' current' : ''}`}
            onClick={() => void openProject(item.id)}
            title="点击打开"
          >
            <div className="lib-cover">
              {item.coverUrl ? (
                <img src={item.coverUrl} alt={item.title} />
              ) : (
                <span>{item.title.slice(0, 1)}</span>
              )}
            </div>

            <div className="lib-info">
              <div className="lib-title-row">
                <span className="lib-title">{item.title}</span>
                {item.id === currentProjectId && <span className="tag">当前</span>}
              </div>
              <div className="lib-sub">
                {item.genre || '未分类'} · {STATUS_LABEL[item.status]}
              </div>
              <div className="lib-desc">{item.logline || <span className="muted">（还没有简介）</span>}</div>
              <div className="lib-meta">
                {item.chapterCount} 章 · {item.wordCount.toLocaleString()} 字 · {item.entityCount} 条设定
                {item.targetWords > 0 && item.wordCount > 0 && (
                  <> · 完成 {Math.min(100, Math.round((item.wordCount / item.targetWords) * 100))}%</>
                )}
              </div>
              <div className="lib-actions" onClick={(e) => e.stopPropagation()}>
                <button
                  style={{ padding: '3px 10px', fontSize: 12 }}
                  disabled={busyId === item.id}
                  onClick={() => void openProject(item.id)}
                >
                  打开
                </button>
                <button
                  style={{ padding: '3px 10px', fontSize: 12 }}
                  onClick={() => setEditor({ project: item })}
                >
                  编辑
                </button>
                <button
                  className="danger"
                  style={{ padding: '3px 10px', fontSize: 12 }}
                  disabled={busyId === item.id}
                  onClick={() => void remove(item)}
                >
                  删除
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      <ProjectDialog
        open={editor !== null}
        project={editor?.project ?? null}
        onClose={() => setEditor(null)}
        onSaved={refresh}
      />
    </Modal>
  );
}
