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

/**
 * 本地草稿兜底。
 * 切章时的兜底保存是「发出去就不管」的异步请求，一旦失败（服务重启、磁盘问题），
 * 脏标记已经被清掉，beforeunload 也不再拦截，那一段就直接没了。
 * 这里把失败的内容写进 localStorage，下次打开本章时恢复。
 */
const DRAFT_PREFIX = 'novelforge:draft:';
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

type DraftPayload = Omit<EditSnapshot, 'dirty'> & { at: number };

function saveLocalDraft(s: Omit<EditSnapshot, 'dirty'>): void {
  try {
    localStorage.setItem(
      DRAFT_PREFIX + s.chapterId,
      JSON.stringify({ ...s, at: Date.now() } satisfies DraftPayload),
    );
  } catch {
    /* 存不下（隐私模式/配额满）就算了，不能让保底逻辑反而报错 */
  }
}

function readLocalDraft(chapterId: string): DraftPayload | null {
  try {
    const raw = localStorage.getItem(DRAFT_PREFIX + chapterId);
    if (!raw) return null;
    const d = JSON.parse(raw) as DraftPayload;
    if (!d || typeof d.content !== 'string') return null;
    if (Date.now() - (d.at ?? 0) > DRAFT_TTL_MS) {
      clearLocalDraft(chapterId);
      return null;
    }
    return d;
  } catch {
    return null;
  }
}

function clearLocalDraft(chapterId: string): void {
  try {
    localStorage.removeItem(DRAFT_PREFIX + chapterId);
  } catch {
    /* ignore */
  }
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
  /** 规划区（细纲/场景卡/AI 整改）默认收起，避免把正文挤成 0 高度 */
  const [showLayers, setShowLayers] = useState(false);
  const [planTarget, setPlanTarget] = useState<'outline' | 'beats'>('outline');
  const [planInput, setPlanInput] = useState('');
  const [planBusy, setPlanBusy] = useState(false);
  const [planResult, setPlanResult] = useState<{ mode: 'ask' | 'revise'; text: string } | null>(
    null,
  );
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
        .then(() => {
          clearLocalDraft(prev.chapterId);
          return refresh();
        })
        .catch((e) => {
          // 保存失败：先把内容落到 localStorage，否则切走后这段就彻底没了
          saveLocalDraft(prev);
          setError(`上一章保存失败，内容已暂存在本地：${(e as Error).message}`);
        });
    }

    // 本章有上次失败留下的草稿，优先恢复它
    const local = readLocalDraft(chapter.id);
    if (local) {
      setTitle(local.title);
      setContent(local.content);
      setOutline(local.outline);
      setBeats(local.beats);
      setDirty(true);
      snapshotRef.current = { ...local, dirty: true };
      setError('检测到上次未保存成功的本地草稿，已恢复；确认无误后按 Ctrl+S 保存');
    } else {
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
    }

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
      clearLocalDraft(chapter.id);
      await refresh();
    } catch (e) {
      saveLocalDraft({ chapterId: chapter.id, title, content, outline, beats });
      setError(`保存失败，内容已暂存在本地：${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  /** 对大纲 / 细纲提问或要求整改 */
  async function revisePlan(mode: 'ask' | 'revise') {
    if (!chapter || !planInput.trim()) return;
    setPlanBusy(true);
    setPlanResult(null);
    try {
      const r = await api.post<{ mode: 'ask' | 'revise'; text: string }>(
        '/api/ai/revise-plan',
        {
          projectId: chapter.projectId,
          chapterId: chapter.id,
          field: planTarget,
          mode,
          instruction: planInput.trim(),
        },
      );
      setPlanResult(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPlanBusy(false);
    }
  }

  /** 把整改结果应用到对应字段（只是填进输入框和本地状态，仍需保存） */
  function applyPlan() {
    if (!planResult || planResult.mode !== 'revise') return;
    if (planTarget === 'outline') {
      setOutline(planResult.text);
      markEdit({ outline: planResult.text });
    } else {
      setBeats(planResult.text);
      markEdit({ beats: planResult.text });
    }
    setPlanResult(null);
    setPlanInput('');
  }

  /** 单章补大纲（目录只出了名字时用） */
  async function genOutline() {
    if (!chapter) return;
    setLayerBusy(true);
    try {
      const updated = await api.post<Chapter>(`/api/chapters/${chapter.id}/fill-outline`);
      setOutline(updated.outline);
      markEdit({ outline: updated.outline });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLayerBusy(false);
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
            <label style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>本章大纲（AI 写作依据，也用于长期记忆）</span>
              <button
                className="count-chip"
                onClick={() => void genOutline()}
                disabled={layerBusy}
                title="让 AI 为本章补写大纲"
              >
                {layerBusy ? '生成中…' : 'AI 写大纲'}
              </button>
            </label>
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

          {/* 规划区（细纲 / 场景卡 / AI 整改）默认收起 */}
          <div className="layers-bar">
            <span className="layers-title">
              规划区
              <span className="layers-meta">
                细纲{beats.trim() ? ` ${beats.trim().length} 字` : '（空）'} · 场景 {scenes.length}
              </span>
            </span>
            <button className="ghost" onClick={() => setShowLayers((v) => !v)}>
              {showLayers ? '收起 ▲' : '展开 ▼'}
            </button>
          </div>

          {showLayers && (
            <>
          {/* 大纲/细纲：提问与整改 */}
          <div className="field" style={{ marginBottom: 0 }}>
            <label style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span>AI 提问 / 整改</span>
              <span style={{ display: 'flex', gap: 4 }}>
                <button
                  className={`count-chip${planTarget === 'outline' ? ' on' : ''}`}
                  onClick={() => setPlanTarget('outline')}
                >
                  针对大纲
                </button>
                <button
                  className={`count-chip${planTarget === 'beats' ? ' on' : ''}`}
                  onClick={() => setPlanTarget('beats')}
                >
                  针对细纲
                </button>
              </span>
            </label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                value={planInput}
                onChange={(e) => setPlanInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) void revisePlan('revise');
                }}
                placeholder="问：这章会不会跟第3章冲突？  改：把冲突提前到开头，压成三拍"
                style={{ flex: 1 }}
              />
              <button
                onClick={() => void revisePlan('ask')}
                disabled={planBusy || !planInput.trim()}
                title="只回答，不改文本"
              >
                提问
              </button>
              <button
                className="primary"
                onClick={() => void revisePlan('revise')}
                disabled={planBusy || !planInput.trim()}
                title="按你的要求重写这一段"
              >
                {planBusy ? '处理中…' : '整改'}
              </button>
            </div>

            {planResult && (
              <div className="plan-result">
                <div className="plan-result-head">
                  <span>{planResult.mode === 'ask' ? '回答' : `整改后的${planTarget === 'outline' ? '大纲' : '细纲'}`}</span>
                  <span style={{ display: 'flex', gap: 6 }}>
                    {planResult.mode === 'revise' && (
                      <button style={{ padding: '2px 8px', fontSize: 11 }} onClick={applyPlan}>
                        应用
                      </button>
                    )}
                    <button
                      className="ghost"
                      style={{ padding: '2px 8px', fontSize: 11 }}
                      onClick={() => setPlanResult(null)}
                    >
                      关闭
                    </button>
                  </span>
                </div>
                <div className="plan-result-body">{planResult.text}</div>
              </div>
            )}
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
            </>
          )}

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
