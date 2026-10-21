import { useEffect, useState } from 'react';
import type { Chapter, ChapterVersionSummary } from '@novelforge/shared';
import { api } from '../api/client';
import { useNovel } from '../store/novel';
import { Modal } from './Modal';

const REASON_LABEL: Record<string, string> = {
  autosave: '自动保存',
  manual: '手动保存',
  'ai-apply': 'AI 写入前',
  restore: '恢复前',
  outline: '大纲修改前',
};

/**
 * 章节历史版本。
 * 自动保存有 5 分钟节流，AI 整章替换/手动保存/恢复会强制留档。
 */
export function VersionHistoryDialog({
  open,
  onClose,
  chapterId,
  onRestored,
}: {
  open: boolean;
  onClose: () => void;
  chapterId: string;
  onRestored: (chapter: Chapter) => void;
}) {
  const setError = useNovel((s) => s.setError);
  const [versions, setVersions] = useState<ChapterVersionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    setVersions([]);
    api
      .get<ChapterVersionSummary[]>(`/api/chapters/${chapterId}/versions?limit=40`)
      .then((list) => {
        if (alive) setVersions(list);
      })
      .catch((e) => {
        if (alive) setError((e as Error).message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, chapterId, setError]);

  async function restore(v: ChapterVersionSummary) {
    if (
      !confirm(
        `恢复到 ${new Date(v.createdAt).toLocaleString()} 的版本？\n\n当前内容会先自动留一份，恢复后仍可再找回。`,
      )
    ) {
      return;
    }
    setRestoring(v.id);
    try {
      const chapter = await api.post<Chapter>(
        `/api/chapters/${chapterId}/versions/${v.id}/restore`,
      );
      onRestored(chapter);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRestoring(null);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="历史版本">
      {loading && <div className="empty">读取中…</div>}
      {!loading && versions.length === 0 && (
        <div className="empty">还没有历史版本。手动保存或 AI 整章替换后会自动留档。</div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: '60vh', overflow: 'auto' }}>
        {versions.map((v) => (
          <div
            key={v.id}
            style={{
              border: '1px solid var(--border)',
              borderRadius: 6,
              padding: '8px 10px',
              display: 'flex',
              gap: 10,
              alignItems: 'flex-start',
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                {new Date(v.createdAt).toLocaleString()} · {REASON_LABEL[v.reason] ?? v.reason} ·{' '}
                {v.wordCount} 字
              </div>
              <div style={{ marginTop: 4, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {v.title}
              </div>
              <div style={{ marginTop: 2, fontSize: 12, opacity: 0.75, lineHeight: 1.6 }}>
                {v.excerpt || '（空章节）'}
              </div>
            </div>
            <button onClick={() => void restore(v)} disabled={restoring !== null}>
              {restoring === v.id ? '恢复中…' : '恢复'}
            </button>
          </div>
        ))}
      </div>
      <div className="hint" style={{ marginTop: 10 }}>
        每章最多保留 40 份；自动保存 5 分钟内只留一份，AI 整章替换会强制留档。
      </div>
    </Modal>
  );
}
