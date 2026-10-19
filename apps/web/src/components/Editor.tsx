import { useEffect, useRef, useState } from 'react';
import { useNovel } from '../store/novel';
import { api } from '../api/client';
import type { Chapter, Scene } from '@novelforge/shared';

/**
 * 编辑区本地状态快照。
 *
 * 存在的意义：切换章节时先把「上一章还没落库的修改」写回，
 * 否则用户打完字 1.2 秒内切章，防抖定时器被清掉，内容就丢了。
 */
interface EditSnapshot {
  chapterId: string;
  title: string;
  content: string;
  outline: string;
  beats: string;
  dirty: boolean;
}

/** 中间：章节正文编辑器 */
export function Editor() {
  const chapter = useNovel((s) => s.currentChapter);
  const loadChapter = useNovel((s) => s.loadChapter);
  const refresh = useNovel((s) => s.refresh);
  const setError = useNovel((s) => s.setError);

  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [outline, setOutline] = useState('');
  const [beats, setBeats] = useState('');
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [layerBusy, setLayerBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fictionRef = useRef<HTMLTextAreaElement | null>(null);
  const snapshotRef = useRef<EditSnapshot | null>(null);
  const scrollToBottomRef = useRef(false);

  /** 用户改动时同步状态与快照（快照用于切章时兜底保存） */
  function markEdit(patch: Partial<Pick<EditSnapshot, 'title' | 'content' | 'outline' | 'beats'>>) {
    setDirty(true);
    const s = snapshotRef.current;
    if (s) snapshotRef.current = { ...s, ...patch, dirty: true };
  }

  // 章节切换：先兜底保存上一章，再同步新章节
  useEffect(() => {
    if (!chapter) return;

    const prev = snapshotRef.current;
    if (prev && prev.chapterId !== chapter.id && prev.dirty) {
      void api
        .patch<Chapter>(`/api/chapters/${prev.chapterId}`, {
          title: prev.title,
          content: prev.content,
          outline: prev.outline,
          beats: prev.beats,
        })
        .then(() => refresh())
        .catch((e) => setError((e as Error).message));
    }

    setTitle(chapter.title);
    setContent(chapter.content);
    setOutline(chapter.outline);
    setBeats(chapter.beats ?? '');
    setDirty(false);
    snapshotRef.current = {
      chapterId: chapter.id,
      title: chapter.title,
      content: chapter.content,
      outline: chapter.outline,
      beats: chapter.beats ?? '',
      dirty: false,
    };

    // 加载本章场景卡
    void api
      .get<Scene[]>(`/api/chapters/${chapter.id}/scenes`)
      .then(setScenes)
      .catch(() => setScenes([]));

    // 切章后回到顶部
    const el = fictionRef.current;
    if (el) el.scrollTop = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  }, [content, outline, title, beats]);

  // 关闭/刷新页面前提醒未保存
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (snapshotRef.current?.dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  // Ctrl+S 保存
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void doSave();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, content, outline, chapter?.id]);

  // AI 回填：支持「插入到光标」与「追加到末尾」
  useEffect(() => {
    function onApply(e: Event) {
      const detail = (e as CustomEvent<unknown>).detail;
      const isObj = typeof detail === 'object' && detail !== null;
      const text = isObj ? (detail as { text?: string }).text ?? '' : (detail as string) ?? '';
      const mode = isObj ? (detail as { mode?: string }).mode ?? 'append' : 'append';
      if (!text) return;

      if (mode === 'insert') {
        insertAtCursor(text);
      } else if (mode === 'replace') {
        // 整章生成/重写：整段替换
        setContent(text);
        markEdit({ content: text });
        const el = fictionRef.current;
        if (el) el.scrollTop = 0;
      } else {
        const next = content + text;
        scrollToBottomRef.current = true;
        setContent(next);
        markEdit({ content: next });
      }
    }
    function insertAtCursor(text: string) {
      const el = fictionRef.current;
      const start = el?.selectionStart ?? content.length;
      const end = el?.selectionEnd ?? content.length;
      const next = content.slice(0, start) + text + content.slice(end);
      setContent(next);
      markEdit({ content: next });
      requestAnimationFrame(() => {
        if (!el) return;
        el.focus();
        const caret = start + text.length;
        el.setSelectionRange(caret, caret);
      });
    }
    window.addEventListener('novelforge:apply', onApply);
    window.addEventListener('novelforge:replace', onApply);
    return () => {
      window.removeEventListener('novelforge:apply', onApply);
      window.removeEventListener('novelforge:replace', onApply);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content]);

  // 追加内容后滚到底部
  useEffect(() => {
    if (!scrollToBottomRef.current) return;
    scrollToBottomRef.current = false;
    const el = fictionRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [content]);

  async function doSave() {
    if (!chapter) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaving(true);
    try {
      const updated = await api.patch<Chapter>(`/api/chapters/${chapter.id}`, {
        title,
        content,
        outline,
        beats,
      });
      if (snapshotRef.current?.chapterId === updated.id) {
        snapshotRef.current = {
          chapterId: updated.id,
          title: updated.title,
          content: updated.content,
          outline: updated.outline,
          beats: updated.beats ?? '',
          dirty: false,
        };
      }
      setDirty(false);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  /** 大纲 → 细纲 */
  async function genBeats() {
    if (!chapter) return;
    setLayerBusy(true);
    try {
      const r = await api.post<{ beats: string }>('/api/ai/chapter-beats', {
        projectId: chapter.projectId,
        chapterId: chapter.id,
      });
      setBeats(r.beats);
      markEdit({ beats: r.beats });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLayerBusy(false);
    }
  }

  /** 细纲 → 场景卡 */
  async function genScenes() {
    if (!chapter) return;
    setLayerBusy(true);
    try {
      const r = await api.post<{ scenes: Scene[] }>('/api/ai/scene-cards', {
        projectId: chapter.projectId,
        chapterId: chapter.id,
      });
      setScenes(r.scenes);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLayerBusy(false);
    }
  }

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
            markEdit({ title: e.target.value });
          }}
          style={{ flex: 1 }}
        />
        <span className="save-state" title="Ctrl+S 保存">
          {saving ? '保存中…' : dirty ? '● 未保存' : '已保存'} · {words} 字
        </span>
        <button onClick={() => void doSave()} disabled={saving || !dirty}>
          保存
        </button>
      </div>

      <div className="editor-body">
        <div className="editor-inner">
          <div className="field" style={{ marginBottom: 0 }}>
            <label>本章大纲（AI 写作依据，也用于长期记忆）</label>
            <textarea
              rows={2}
              value={outline}
              placeholder="这一章要发生什么：谁、做了什么、结果如何、留下什么悬念"
              onChange={(e) => {
                setOutline(e.target.value);
                markEdit({ outline: e.target.value });
              }}
            />
          </div>

          {/* 细纲：把大纲拆成可写的节拍 */}
          <div className="field" style={{ marginBottom: 0 }}>
            <label style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>细纲（拆成节拍，可选）</span>
              <button
                className="count-chip"
                onClick={() => void genBeats()}
                disabled={layerBusy}
                title="用 AI 把大纲拆成 5-8 个节拍"
              >
                {layerBusy ? '生成中…' : 'AI 生成细纲'}
              </button>
            </label>
            <textarea
              rows={3}
              value={beats}
              placeholder="1. 场景/动作 → 造成什么变化…（AI 可代劳）"
              onChange={(e) => {
                setBeats(e.target.value);
                markEdit({ beats: e.target.value });
              }}
            />
          </div>

          {/* 场景卡：目标-阻力-结果 */}
          <div className="field" style={{ marginBottom: 0 }}>
            <label style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>
                场景卡{scenes.length > 0 ? `（${scenes.length} 个）` : ''}
              </span>
              <span style={{ display: 'flex', gap: 6 }}>
                <button
                  className="count-chip"
                  onClick={() => void genScenes()}
                  disabled={layerBusy}
                  title="用 AI 把细纲拆成场景卡"
                >
                  {layerBusy ? '生成中…' : 'AI 生成场景'}
                </button>
              </span>
            </label>
            {scenes.length === 0 ? (
              <div className="hint" style={{ marginTop: 0 }}>
                还没有场景卡。先写细纲，再点「AI 生成场景」，写作时会按场景推进。
              </div>
            ) : (
              <div className="scene-list">
                {scenes.map((s, i) => (
                  <div className="scene-card" key={s.id}>
                    <div className="scene-head">
                      <span className="tag">场景 {i + 1}</span>
                      <span className="scene-title">{s.title}</span>
                      {s.location && <span className="summary">@{s.location}</span>}
                    </div>
                    <div className="scene-row">目标：{s.goal || '—'}</div>
                    <div className="scene-row">阻力：{s.conflict || '—'}</div>
                    <div className="scene-row">结果：{s.outcome || '—'}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <textarea
            className="fiction"
            ref={fictionRef}
            value={content}
            placeholder="在这里写正文，或让右侧 AI 帮你续写…"
            onChange={(e) => {
              setContent(e.target.value);
              markEdit({ content: e.target.value });
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
