import { useEffect, useRef, useState } from 'react';
import { useNovel } from '../store/novel';
import { api } from '../api/client';
import type { Chapter } from '@novelforge/shared';

/** 中间：章节正文编辑器 */
export function Editor() {
  const chapter = useNovel((s) => s.currentChapter);
  const loadChapter = useNovel((s) => s.loadChapter);
  const refresh = useNovel((s) => s.refresh);
  const setError = useNovel((s) => s.setError);

  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [outline, setOutline] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 切换章节时同步本地状态
  useEffect(() => {
    if (!chapter) return;
    setTitle(chapter.title);
    setContent(chapter.content);
    setOutline(chapter.outline);
    setDirty(false);
  }, [chapter?.id]);

  // 自动保存（1.2s 防抖）
  useEffect(() => {
    if (!dirty || !chapter) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void doSave(), 1200);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, outline, title]);

  async function doSave() {
    if (!chapter) return;
    setSaving(true);
    try {
      const updated = await api.patch<Chapter>(`/api/chapters/${chapter.id}`, {
        title,
        content,
        outline,
      });
      await loadChapter(updated.id);
      await refresh();
      setDirty(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  // 生成结果写回正文（由 AI 面板通过自定义事件触发）
  useEffect(() => {
    function onApply(e: Event) {
      const text = (e as CustomEvent<string>).detail ?? '';
      if (!text) return;
      setContent((prev) => prev + text);
      setDirty(true);
    }
    function onReplace(e: Event) {
      const text = (e as CustomEvent<string>).detail ?? '';
      if (!text) return;
      setContent(text);
      setDirty(true);
    }
    window.addEventListener('novelforge:apply', onApply);
    window.addEventListener('novelforge:replace', onReplace);
    return () => {
      window.removeEventListener('novelforge:apply', onApply);
      window.removeEventListener('novelforge:replace', onReplace);
    };
  }, []);

  if (!chapter) {
    return (
      <div className="main">
        <div className="empty" style={{ marginTop: 120 }}>
          从左侧选择或新建一个章节开始写作
        </div>
      </div>
    );
  }

  const words = countWordsLocal(content);

  return (
    <div className="main">
      <div className="editor-head">
        <input
          className="title"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            setDirty(true);
          }}
          style={{ flex: 1 }}
        />
        <span style={{ fontSize: 12, color: 'var(--muted)', flexShrink: 0 }}>
          {saving ? '保存中…' : dirty ? '未保存' : '已保存'} · {words} 字
        </span>
        <button onClick={() => void doSave()} disabled={saving || !dirty}>
          保存
        </button>
      </div>

      <div className="editor-body">
        <div className="editor-inner">
          <div className="field" style={{ marginBottom: 14 }}>
            <label>本章大纲（AI 写作依据，也用于长期记忆）</label>
            <textarea
              rows={3}
              value={outline}
              placeholder="这一章要发生什么：谁、做了什么、结果如何、留下什么悬念"
              onChange={(e) => {
                setOutline(e.target.value);
                setDirty(true);
              }}
            />
          </div>

          <textarea
            className="fiction"
            value={content}
            placeholder="在这里写正文，或让右侧 AI 帮你续写…"
            onChange={(e) => {
              setContent(e.target.value);
              setDirty(true);
            }}
            style={{ height: 'auto' }}
            onInput={(e) => {
              const el = e.currentTarget;
              el.style.height = 'auto';
              el.style.height = `${el.scrollHeight}px`;
            }}
          />
        </div>
      </div>
    </div>
  );
}

/** 与后端一致的粗略字数统计 */
function countWordsLocal(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fa5]/g) ?? []).length;
  const words = (text.match(/[A-Za-z0-9_'-]+/g) ?? []).length;
  return cjk + words;
}
