import { useState } from 'react';
import type { ExportFormat } from '@novelforge/shared';
import { useNovel } from '../store/novel';
import { api } from '../api/client';
import { Modal } from './Modal';

const FORMATS: { key: ExportFormat; label: string; desc: string }[] = [
  { key: 'txt', label: 'TXT', desc: '纯文本，投稿/备份通用' },
  { key: 'md', label: 'Markdown', desc: '保留卷章层级，适合再加工' },
  { key: 'docx', label: 'Word', desc: '带标题层级，可直接排版交付' },
];

export function ExportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const project = useNovel((s) => s.project);
  const chapters = useNovel((s) => s.chapters);
  const setError = useNovel((s) => s.setError);

  const [format, setFormat] = useState<ExportFormat>('txt');
  const [includeOutline, setIncludeOutline] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  if (!project) return null;

  async function run() {
    if (!project) return;
    setBusy(true);
    try {
      await api.download(
        `/api/projects/${project.id}/export`,
        {
          format,
          includeOutline,
          chapterIds: selected.size > 0 ? [...selected] : undefined,
        },
        `${project.title}.${format}`,
      );
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  return (
    <Modal open={open} onClose={onClose} title="导出成稿">
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        {FORMATS.map((f) => (
          <button
            key={f.key}
            className={format === f.key ? 'primary' : ''}
            onClick={() => setFormat(f.key)}
            style={{ flex: 1, padding: '10px 8px', textAlign: 'center' }}
          >
            <div style={{ fontWeight: 600 }}>{f.label}</div>
            <div style={{ fontSize: 10, opacity: 0.75, marginTop: 3 }}>{f.desc}</div>
          </button>
        ))}
      </div>

      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, marginBottom: 12 }}>
        <input
          type="checkbox"
          checked={includeOutline}
          onChange={(e) => setIncludeOutline(e.target.checked)}
          style={{ width: 'auto' }}
        />
        同时导出章节大纲
      </label>

      <div className="field">
        <label>
          选择章节（不选 = 导出全部 {chapters.length} 章）
        </label>
        <div
          style={{
            maxHeight: 220,
            overflowY: 'auto',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: 6,
          }}
        >
          {chapters.map((c) => (
            <label
              key={c.id}
              style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 6px', fontSize: 13 }}
            >
              <input
                type="checkbox"
                checked={selected.has(c.id)}
                onChange={() => toggle(c.id)}
                style={{ width: 'auto' }}
              />
              {c.title}
              <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--muted)' }}>
                {c.wordCount} 字
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
        <button onClick={onClose}>取消</button>
        <button className="primary" onClick={run} disabled={busy}>
          {busy ? '导出中…' : '下载'}
        </button>
      </div>
    </Modal>
  );
}
