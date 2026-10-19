import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ProjectOverview, ProjectStatus } from '@novelforge/shared';
import { useNovel } from '../store/novel';
import { api } from '../api/client';
import { ProjectDialog } from './ProjectDialog';
import { SettingsDialog } from './SettingsDialog';
import { AiNovelDialog } from './AiNovelDialog';

const STATUS_LABEL: Record<ProjectStatus, string> = {
  drafting: '写作中',
  paused: '暂停',
  finished: '已完结',
  archived: '已归档',
};

/**
 * 书架：应用的主页面。
 * 打开软件先看到所有作品，点某一本才进入写作界面。
 */
export function ShelfPage({ onOpenWorkspace }: { onOpenWorkspace: () => void }) {
  const currentProjectId = useNovel((s) => s.currentProjectId);
  const selectProject = useNovel((s) => s.selectProject);
  const clearProject = useNovel((s) => s.clearProject);
  const loadProjects = useNovel((s) => s.loadProjects);
  const setError = useNovel((s) => s.setError);

  const [items, setItems] = useState<ProjectOverview[]>([]);
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState<{ project: ProjectOverview | null } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setItems(await api.get<ProjectOverview[]>('/api/projects/overview'));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [setError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
      onOpenWorkspace();
    } catch (e) {
      setError((e as Error).message);
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
    <div className="shelf">
      <header className="shelf-head">
        <div className="brand">
          NovelForge <small>AI 创作台</small>
        </div>
        <div style={{ flex: 1 }} />
        <button className="ghost" onClick={() => setSettingsOpen(true)}>
          ⚙ 设置
        </button>
      </header>

      <main className="shelf-main">
        <div className="shelf-toolbar">
          <h1>我的作品</h1>
          <div style={{ flex: 1 }} />
          <input
            className="shelf-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索书名、题材或简介…"
          />
          <button className="primary" onClick={() => setAiOpen(true)} title="描述需求，让 AI 直接生成一部小说">
            ✨ AI 生成小说
          </button>
          <button onClick={() => setEditor({ project: null })}>＋ 手动新建</button>
        </div>

        {items.length > 0 && (
          <div className="shelf-stats">
            共 {items.length} 部作品 · 累计 {totalWords.toLocaleString()} 字
          </div>
        )}

        {loading && <div className="empty">正在加载…</div>}

        {!loading && shown.length === 0 && (
          <div className="empty shelf-empty">
            {items.length === 0 ? (
              <>
                书架还是空的
                <br />
                点右上角「＋ 新建作品」写下第一本
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
              title="点击打开这本书"
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
                  {item.id === currentProjectId && <span className="tag">上次打开</span>}
                </div>
                <div className="lib-sub">
                  {item.genre || '未分类'} · {STATUS_LABEL[item.status]}
                </div>
                <div className="lib-desc">
                  {item.logline || <span className="muted">（还没有简介）</span>}
                </div>
                <div className="lib-meta">
                  {item.chapterCount} 章 · {item.wordCount.toLocaleString()} 字 · {item.entityCount} 条设定
                  {item.targetWords > 0 && item.wordCount > 0 && (
                    <> · 完成 {Math.min(100, Math.round((item.wordCount / item.targetWords) * 100))}%</>
                  )}
                </div>
                <div className="lib-actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    className="primary"
                    style={{ padding: '3px 12px', fontSize: 12 }}
                    disabled={busyId === item.id}
                    onClick={() => void openProject(item.id)}
                  >
                    {busyId === item.id ? '打开中…' : '打开'}
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
      </main>

      <ProjectDialog
        open={editor !== null}
        project={editor?.project ?? null}
        onClose={() => setEditor(null)}
        onSaved={refresh}
      />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <AiNovelDialog
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        onCreated={async (projectId) => {
          await selectProject(projectId);
          onOpenWorkspace();
        }}
      />
    </div>
  );
}
