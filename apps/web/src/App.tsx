import { useEffect, useState } from 'react';
import { useNovel } from './store/novel';
import { Sidebar } from './components/Sidebar';
import { Editor } from './components/Editor';
import { AiPanel } from './components/AiPanel';
import { ProjectDialog } from './components/ProjectDialog';
import { EntityManager } from './components/EntityManager';
import { SettingsDialog } from './components/SettingsDialog';
import { ExportDialog } from './components/ExportDialog';
import { ImageDialog } from './components/ImageDialog';
import { ShelfPage } from './components/ShelfPage';
import { ConsistencyPanel } from './components/ConsistencyPanel';

type DialogKey =
  | 'project-new'
  | 'project-edit'
  | 'entities'
  | 'settings'
  | 'export'
  | 'image'
  | 'consistency'
  | null;

/** 书架（主页） / 写作台 */
type View = 'shelf' | 'workspace';

export function App() {
  const project = useNovel((s) => s.project);
  const loading = useNovel((s) => s.loading);
  const error = useNovel((s) => s.error);
  const clearError = useNovel((s) => s.clearError);
  const loadProjects = useNovel((s) => s.loadProjects);

  /** 打开软件默认落在书架，而不是直接进编辑器 */
  const [view, setView] = useState<View>('shelf');
  const [dialog, setDialog] = useState<DialogKey>(null);

  // 进入写作台时加载作品列表（侧边栏下拉要用）
  useEffect(() => {
    if (view === 'workspace') void loadProjects();
  }, [view, loadProjects]);

  // 错误提示 4 秒自动消失
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(clearError, 4000);
    return () => clearTimeout(t);
  }, [error, clearError]);

  return (
    <>
      {loading && <div className="loading-bar" />}

      {view === 'shelf' ? (
        <ShelfPage onOpenWorkspace={() => setView('workspace')} />
      ) : (
        <div className="app">
          <Sidebar
            onNewProject={() => setDialog('project-new')}
            onEditProject={() => setDialog('project-edit')}
            onBackToShelf={() => setView('shelf')}
          />

          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <TopBar
              onOpen={setDialog}
              hasProject={Boolean(project)}
              onBackToShelf={() => setView('shelf')}
            />
            <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
              <Editor />
              <AiPanel />
            </div>
          </div>

          <ProjectDialog
            open={dialog === 'project-new' || dialog === 'project-edit'}
            onClose={() => setDialog(null)}
            // 只有「编辑」才把当前作品传进去；新建必须传 null，否则会变成改当前书
            project={dialog === 'project-edit' ? project : null}
          />
          <EntityManager open={dialog === 'entities'} onClose={() => setDialog(null)} />
          <SettingsDialog open={dialog === 'settings'} onClose={() => setDialog(null)} />
          <ExportDialog open={dialog === 'export'} onClose={() => setDialog(null)} />
          <ImageDialog open={dialog === 'image'} onClose={() => setDialog(null)} />
          <ConsistencyPanel open={dialog === 'consistency'} onClose={() => setDialog(null)} />
        </div>
      )}

      {error && <div className="toast">{error}</div>}
    </>
  );
}

function TopBar({
  onOpen,
  hasProject,
  onBackToShelf,
}: {
  onOpen: (d: DialogKey) => void;
  hasProject: boolean;
  onBackToShelf: () => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 6,
        padding: '8px 20px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--panel)',
        flexShrink: 0,
      }}
    >
      <button className="ghost" onClick={onBackToShelf} title="返回书架">
        ← 书架
      </button>
      <button className="ghost" onClick={() => onOpen('entities')} disabled={!hasProject}>
        📚 设定库
      </button>
      <button className="ghost" onClick={() => onOpen('consistency')} disabled={!hasProject}>
        🧩 设定中心
      </button>
      <button className="ghost" onClick={() => onOpen('image')} disabled={!hasProject}>
        🎨 配图
      </button>
      <button className="ghost" onClick={() => onOpen('export')} disabled={!hasProject}>
        📤 导出
      </button>
      <div style={{ flex: 1 }} />
      <button className="ghost" onClick={() => onOpen('settings')}>
        ⚙ 设置
      </button>
    </div>
  );
}
