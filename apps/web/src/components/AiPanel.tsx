import { useEffect, useRef, useState } from 'react';
import type { MemoryUsage, WriteMode } from '@novelforge/shared';
import { useNovel } from '../store/novel';
import { api } from '../api/client';
import { streamWrite } from '../api/stream';

const MODES: { key: WriteMode; label: string; hint: string }[] = [
  { key: 'continue', label: '续写', hint: '顺着正文往下写' },
  { key: 'rewrite', label: '改写', hint: '改写选中片段' },
  { key: 'polish', label: '润色', hint: '改善表达' },
  { key: 'expand', label: '扩写', hint: '补充细节' },
  { key: 'style', label: '仿写', hint: '模仿指定文风' },
];

/** 右侧：AI 写作面板 */
export function AiPanel() {
  const chapter = useNovel((s) => s.currentChapter);
  const project = useNovel((s) => s.project);
  const setError = useNovel((s) => s.setError);

  const [mode, setMode] = useState<WriteMode>('continue');
  const [instruction, setInstruction] = useState('');
  const [result, setResult] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [memory, setMemory] = useState<MemoryUsage[]>([]);
  const [summary, setSummary] = useState('');
  const abortRef = useRef<(() => void) | null>(null);
  /** 本次生成属于哪一章：切章后结果不该再往新章节里塞 */
  const startedForRef = useRef<string | null>(null);
  /** 本次结果是用哪个模式生成的，决定「替换正文」还是「插入/追加」 */
  const [resultMode, setResultMode] = useState<WriteMode | null>(null);

  function generate(modeOverride?: WriteMode) {
    if (!project || !chapter) return;
    const useMode = modeOverride ?? mode;
    setResult('');
    setMemory([]);
    setStreaming(true);
    setResultMode(useMode);
    startedForRef.current = chapter.id;

    abortRef.current = streamWrite(
      {
        projectId: project.id,
        chapterId: chapter.id,
        mode: useMode,
        instruction: instruction.trim() || undefined,
        selection:
          useMode === 'chapter' || useMode === 'chapter-rewrite'
            ? undefined
            : useMode === 'continue'
              ? undefined
              : getSelectionText() || undefined,
        memoryBudget: 6000,
      },
      {
        onMeta: (m) => setMemory(m),
        onDelta: (t) => setResult((prev) => prev + t),
        onDone: () => setStreaming(false),
        onError: (msg) => {
          setError(msg);
          setStreaming(false);
        },
      },
    );
  }

  function stop() {
    abortRef.current?.();
    setStreaming(false);
  }

  // 生成过程中切了章节：停止生成，避免结果错位
  useEffect(() => {
    if (!streaming) return;
    if (startedForRef.current && chapter?.id !== startedForRef.current) {
      abortRef.current?.();
      setStreaming(false);
      setError('已切换章节，生成已停止');
    }
  }, [chapter?.id, streaming, setError]);

  // Ctrl+Enter 生成
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        if (!streaming) generate();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming, mode, instruction, chapter?.id, project?.id]);

  function applyToText() {
    if (!result.trim()) return;
    window.dispatchEvent(new CustomEvent('novelforge:apply', { detail: result }));
    setResult('');
  }

  /** 插入到正文光标处（有选区则替换选区）——改写/润色的自然落点 */
  function insertToText() {
    if (!result.trim()) return;
    window.dispatchEvent(
      new CustomEvent('novelforge:apply', { detail: { text: result, mode: 'insert' } }),
    );
    setResult('');
  }

  /** 整章生成/重写：整段替换本章正文 */
  function replaceChapter() {
    if (!result.trim()) return;
    const len = chapter?.content.length ?? 0;
    const ok =
      len === 0 ||
      confirm(
        `将用生成结果替换本章现有正文（${len} 字）。\n\n此操作会覆盖当前内容，但不影响其它章节。确定替换？`,
      );
    if (!ok) return;
    window.dispatchEvent(
      new CustomEvent('novelforge:apply', { detail: { text: result, mode: 'replace' } }),
    );
    setResult('');
  }

  async function makeSummary() {
    if (!chapter) return;
    try {
      const r = await api.post<{ summary: string }>(`/api/chapters/${chapter.id}/summarize`);
      setSummary(r.summary);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!chapter) {
    return (
      <aside className="rightbar">
        <div className="empty">选择一个章节后，这里会出现 AI 工具</div>
      </aside>
    );
  }

  return (
    <aside className="rightbar">
      <div className="ai-tabs">
        {MODES.map((m) => (
          <button
            key={m.key}
            className={mode === m.key ? 'active' : ''}
            onClick={() => setMode(m.key)}
            title={m.hint}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div style={{ padding: 12, borderBottom: '1px solid var(--border)' }}>
        <textarea
          rows={3}
          value={instruction}
          placeholder={
            mode === 'continue'
              ? '额外要求（可留空）：比如「让对峙更紧张」「这一节写回忆」'
              : '说明你希望怎么改'
          }
          onChange={(e) => setInstruction(e.target.value)}
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button
            className="primary"
            style={{ flex: 1 }}
            onClick={() => generate()}
            disabled={streaming}
          >
            {streaming ? '生成中…' : '生成'}
          </button>
          {streaming && <button onClick={stop}>停止</button>}
        </div>

        {/* 整章操作：不依赖选区，直接按大纲产出整章正文 */}
        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          <button
            style={{ flex: 1 }}
            onClick={() => generate('chapter')}
            disabled={streaming}
            title="按本章大纲写出一整章（覆盖结果可在下方一键替换）"
          >
            整章生成
          </button>
          <button
            style={{ flex: 1 }}
            onClick={() => generate('chapter-rewrite')}
            disabled={streaming || !chapter.content.trim()}
            title="参考现有正文重写整章"
          >
            整章重写
          </button>
        </div>

        <div className="hint">
          Ctrl+Enter 快速生成 · 改写/润色前先在正文里选中一段 · 整章生成后再点「替换正文」
        </div>
      </div>

      <div className="result-box">
        {result || (streaming ? '…' : <div className="empty">生成的文本会出现在这里</div>)}
      </div>

      <div className="ai-actions">
        {resultMode === 'chapter' || resultMode === 'chapter-rewrite' ? (
          <>
            <button
              className="primary"
              style={{ flex: 1 }}
              onClick={replaceChapter}
              disabled={!result.trim()}
            >
              替换正文
            </button>
            <button onClick={applyToText} disabled={!result.trim()}>
              追加到末尾
            </button>
          </>
        ) : (
          <>
            <button
              className="primary"
              style={{ flex: 1 }}
              onClick={insertToText}
              disabled={!result.trim()}
            >
              插入到光标
            </button>
            <button style={{ flex: 1 }} onClick={applyToText} disabled={!result.trim()}>
              追加到末尾
            </button>
          </>
        )}
        <button onClick={makeSummary} title="生成该章摘要，供后续章节记忆使用">
          记忆摘要
        </button>
      </div>

      {summary && (
        <div className="result-box" style={{ maxHeight: 120, fontSize: 12, borderTop: '1px solid var(--border)' }}>
          {summary}
        </div>
      )}

      {memory.length > 0 && (
        <div className="memory-badge">
          上下文：{memory.map((m) => `${m.label}(${m.chars})`).join(' · ')}
        </div>
      )}
    </aside>
  );
}

/** 拿浏览器选区文本 */
function getSelectionText(): string {
  const sel = window.getSelection();
  if (sel && sel.toString().trim()) return sel.toString();
  const active = document.activeElement as HTMLTextAreaElement | null;
  if (active?.selectionStart !== undefined && active.selectionEnd !== undefined) {
    return active.value.slice(active.selectionStart, active.selectionEnd);
  }
  return '';
}
