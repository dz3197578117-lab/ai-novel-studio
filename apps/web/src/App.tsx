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

type DialogKey = 'project' | 'entities' | 'settings' | 'export' | 'image' | null;

export function App() {
  const project = useNovel((s) => s.project);
  const loading = useNovel((s) => s.loading);
  const error = useNovel((s) => s.error);
  const clearError = useNovel((s) => s.clearError);
  const loadProjects = useNovel((s) => s.loadProjects);

  const [dialog, setDialog] = useState<DialogKey>(null);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  // 错误提示 3 秒自动消失
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(clearError, 4000);
    return () => clearTimeout(t);
  }, [error, clearError]);

  return (
    <div className="app">
      {loading && <div className="loading-bar" />}

      <Sidebar
        onNewProject={() => setDialog('project')}
        onEditProject={() => setDialog('project')}
      />

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <TopBar onOpen={setDialog} hasProject={Boolean(project)} />
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <Editor />
          <AiPanel />
        </div>
      </div>

      <ProjectDialog
        open={dialog === 'project'}
        onClose={() => setDialog(null)}
        project={dialog === 'project' ? project : null}
      />
      <EntityManager open={dialog === 'entities'} onClose={() => setDialog(null)} />
      <SettingsDialog open={dialog === 'settings'} onClose={() => setDialog(null)} />
      <ExportDialog open={dialog === 'export'} onClose={() => setDialog(null)} />
      <ImageDialog open={dialog === 'image'} onClose={() => setDialog(null)} />

      {error && <div className="toast">{error}</div>}
    </div>
  );
}

function TopBar({
  onOpen,
  hasProject,
}: {
  onOpen: (d: DialogKey) => void;
  hasProject: boolean;
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
      <button className="ghost" onClick={() => onOpen('entities')} disabled={!hasProject}>
        📚 设定库
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
