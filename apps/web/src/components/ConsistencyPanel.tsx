import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ConsistencyIssue,
  ConsistencyReport,
  Foreshadow,
  KnowledgeDoc,
  KnowledgeHit,
  TimelineEvent,
} from '@novelforge/shared';
import { useNovel } from '../store/novel';
import { api } from '../api/client';
import { Modal } from './Modal';

type Tab = 'brainstorm' | 'foreshadow' | 'timeline' | 'knowledge' | 'toc' | 'check';

interface TocPlan {
  volumes: { title: string; summary: string }[];
  chapters: { volumeIndex: number; title: string; outline: string }[];
}

const STATUS_LABEL: Record<string, string> = {
  planted: '未回收',
  recovered: '已回收',
  abandoned: '已放弃',
};

const SEVERITY_LABEL: Record<string, string> = {
  high: '严重',
  medium: '中等',
  low: '轻微',
};

const KIND_LABEL: Record<string, string> = {
  character: '人物',
  timeline: '时间线',
  setting: '设定',
  naming: '称呼',
  plot: '情节',
  foreshadow: '伏笔',
  other: '其它',
};

/**
 * 设定中心：伏笔台账、时间线、一致性检查。
 * 这三样是「写到第 50 章忘了第 3 章」的直接解药。
 */
export function ConsistencyPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const project = useNovel((s) => s.project);
  const chapters = useNovel((s) => s.chapters);
  const setError = useNovel((s) => s.setError);

  const [tab, setTab] = useState<Tab>('brainstorm');
  const [foreshadows, setForeshadows] = useState<Foreshadow[]>([]);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [busy, setBusy] = useState(false);

  // 脑暴板
  const [brainstorm, setBrainstorm] = useState('');

  // 知识库
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [kTitle, setKTitle] = useState('');
  const [kContent, setKContent] = useState('');
  const [kSource, setKSource] = useState('');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<KnowledgeHit[]>([]);

  // 目录生成
  const [tocCount, setTocCount] = useState('20');
  const [tocInstruction, setTocInstruction] = useState('');
  const [tocTitlesOnly, setTocTitlesOnly] = useState(true);
  const [fillBusy, setFillBusy] = useState(false);
  const [fillJob, setFillJob] = useState<{ done: number; total: number } | null>(null);
  const [tocPlan, setTocPlan] = useState<TocPlan | null>(null);
  const [tocBusy, setTocBusy] = useState(false);
  /** 后台任务进度 */
  const [tocJob, setTocJob] = useState<{ done: number; total: number; phase: string } | null>(
    null,
  );

  // 按卷扩展
  const volumes = useNovel((s) => s.volumes);
  const [exVolumeId, setExVolumeId] = useState('');
  const [exVolumeTitle, setExVolumeTitle] = useState('');
  const [exCount, setExCount] = useState('50');
  const [exInstruction, setExInstruction] = useState('');
  const [exBusy, setExBusy] = useState(false);
  const [exJob, setExJob] = useState<{ done: number; total: number } | null>(null);
  const [exPlan, setExPlan] = useState<{
    volumeTitle: string;
    volumeSummary: string;
    chapters: { title: string; outline: string }[];
  } | null>(null);

  // 新增表单
  const [fsTitle, setFsTitle] = useState('');
  const [fsDetail, setFsDetail] = useState('');
  const [fsPlanned, setFsPlanned] = useState('');
  const [fsPlanted, setFsPlanted] = useState('');

  const [tlTitle, setTlTitle] = useState('');
  const [tlTime, setTlTime] = useState('');
  const [tlChapter, setTlChapter] = useState('');

  const [report, setReport] = useState<ConsistencyReport | null>(null);

  const chapterTitle = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of chapters) map.set(c.id, c.title);
    return map;
  }, [chapters]);

  const load = useCallback(async () => {
    if (!project) return;
    try {
      const [fs, tl, ds] = await Promise.all([
        api.get<Foreshadow[]>(`/api/projects/${project.id}/foreshadows`),
        api.get<TimelineEvent[]>(`/api/projects/${project.id}/timeline`),
        api.get<KnowledgeDoc[]>(`/api/projects/${project.id}/knowledge`),
      ]);
      setForeshadows(fs);
      setTimeline(tl);
      setDocs(ds);
      setBrainstorm(project.brainstorm ?? '');
    } catch (e) {
      setError((e as Error).message);
    }
  }, [project, setError]);

  useEffect(() => {
    if (!open) return;
    setTab('brainstorm');
    setReport(null);
    setQuery('');
    setHits([]);
    void load();
  }, [open, load]);

  if (!project) return null;

  async function saveBrainstorm() {
    setBusy(true);
    try {
      await api.patch(`/api/projects/${project!.id}`, { brainstorm });
      await useNovel.getState().selectProject(project!.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function addDoc(text: string, title: string, source: string) {
    if (!text.trim()) return;
    setBusy(true);
    try {
      await api.post(`/api/projects/${project!.id}/knowledge`, {
        title: title.trim() || '未命名资料',
        source,
        content: text,
      });
      setKTitle('');
      setKContent('');
      setKSource('');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function removeDoc(id: string) {
    if (!confirm('删除这份资料？')) return;
    setBusy(true);
    try {
      await api.del(`/api/knowledge/${id}`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function doSearch() {
    try {
      const r = await api.get<{ hits: KnowledgeHit[] }>(
        `/api/projects/${project!.id}/knowledge/search?q=${encodeURIComponent(query)}`,
      );
      setHits(r.hits);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    await addDoc(text, file.name.replace(/\.[^.]+$/, ''), file.name);
    e.target.value = '';
  }

  async function genToc() {
    setTocBusy(true);
    setTocPlan(null);
    setTocJob(null);
    try {
      const started = await api.post<{ jobId: string; batches: number }>(
        `/api/projects/${project!.id}/generate-toc`,
        {
          chapterCount: Number(tocCount) || 20,
          instruction: tocInstruction.trim() || undefined,
          titlesOnly: tocTitlesOnly,
        },
      );

      // 后台任务：轮询进度，1000 章可能要跑几十分钟
      type JobResp = {
        status: 'running' | 'done' | 'error';
        progress: { done: number; total: number; phase: string };
        result?: TocPlan;
        error?: string;
      };
      let job: JobResp | null = null;
      for (let i = 0; i < 3600; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        job = await api.get<JobResp>(`/api/jobs/${started.jobId}`);
        setTocJob(job.progress);
        if (job.status === 'done') break;
        if (job.status === 'error') throw new Error(job.error || '生成失败');
      }
      if (!job || job.status !== 'done' || !job.result) {
        throw new Error('生成超时，请重试');
      }
      setTocPlan(job.result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setTocBusy(false);
      setTocJob(null);
    }
  }

  /** 批量补全缺失大纲（目录先出名字，大纲后期补） */
  async function fillOutlines() {
    setFillBusy(true);
    setFillJob(null);
    try {
      const started = await api.post<{ jobId: string; chapterCount: number; batches: number }>(
        `/api/projects/${project!.id}/fill-outlines`,
        { onlyMissing: true },
      );
      type JobResp = {
        status: 'running' | 'done' | 'error';
        progress: { done: number; total: number };
        result?: { filled: number; failed: string[] };
        error?: string;
      };
      let job: JobResp | null = null;
      for (let i = 0; i < 3600; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        job = await api.get<JobResp>(`/api/jobs/${started.jobId}`);
        setFillJob(job.progress);
        if (job.status === 'done') break;
        if (job.status === 'error') throw new Error(job.error || '补全失败');
      }
      if (!job || job.status !== 'done' || !job.result) throw new Error('补全超时，请重试');
      await useNovel.getState().selectProject(project!.id);
      setError(
        `已补全 ${job.result.filled} 章大纲` +
          (job.result.failed.length ? `，${job.result.failed.length} 章失败` : ''),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setFillBusy(false);
      setFillJob(null);
    }
  }

  async function applyToc() {
    if (!tocPlan) return;
    setTocBusy(true);
    try {
      const r = await api.post<{ counts: { volumes: number; chapters: number } }>(
        `/api/projects/${project!.id}/apply-toc`,
        tocPlan,
      );
      setTocPlan(null);
      await useNovel.getState().selectProject(project!.id);
      setError(
        `已写入 ${r.counts.volumes} 卷 ${r.counts.chapters} 章（追加到现有目录末尾）`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setTocBusy(false);
    }
  }

  /** 按卷生成本卷章节（后台任务） */
  async function genVolume() {
    setExBusy(true);
    setExPlan(null);
    setExJob(null);
    try {
      const started = await api.post<{ jobId: string; batches: number; volumeTitle: string }>(
        `/api/projects/${project!.id}/expand-volume`,
        {
          volumeId: exVolumeId || undefined,
          volumeTitle: exVolumeTitle.trim() || undefined,
          chapterCount: Number(exCount) || 50,
          instruction: exInstruction.trim() || undefined,
        },
      );

      type JobResp = {
        status: 'running' | 'done' | 'error';
        progress: { done: number; total: number };
        result?: {
          volumeTitle: string;
          volumeSummary: string;
          chapters: { title: string; outline: string }[];
        };
        error?: string;
      };
      let job: JobResp | null = null;
      for (let i = 0; i < 3600; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        job = await api.get<JobResp>(`/api/jobs/${started.jobId}`);
        setExJob(job.progress);
        if (job.status === 'done') break;
        if (job.status === 'error') throw new Error(job.error || '生成失败');
      }
      if (!job || job.status !== 'done' || !job.result) throw new Error('生成超时，请重试');
      setExPlan(job.result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setExBusy(false);
      setExJob(null);
    }
  }

  async function applyVolume() {
    if (!exPlan) return;
    setExBusy(true);
    try {
      const r = await api.post<{ counts: { chapters: number } }>(
        `/api/projects/${project!.id}/apply-volume-chapters`,
        {
          volumeId: exVolumeId || undefined,
          volumeTitle: exPlan.volumeTitle,
          volumeSummary: exPlan.volumeSummary,
          chapters: exPlan.chapters,
        },
      );
      setExPlan(null);
      await useNovel.getState().selectProject(project!.id);
      setError(`已写入 ${r.counts.chapters} 章到「${exPlan.volumeTitle}」`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setExBusy(false);
    }
  }

  async function addForeshadow() {
    if (!fsTitle.trim()) return;
    setBusy(true);
    try {
      await api.post(`/api/projects/${project!.id}/foreshadows`, {
        title: fsTitle.trim(),
        detail: fsDetail.trim(),
        plantedChapterId: fsPlanted || null,
        plannedChapterId: fsPlanned || null,
      });
      setFsTitle('');
      setFsDetail('');
      setFsPlanned('');
      setFsPlanted('');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(f: Foreshadow, status: 'planted' | 'recovered' | 'abandoned') {
    setBusy(true);
    try {
      await api.patch(`/api/foreshadows/${f.id}`, { status });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function removeForeshadow(id: string) {
    if (!confirm('删除这条伏笔记录？')) return;
    setBusy(true);
    try {
      await api.del(`/api/foreshadows/${id}`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function addEvent() {
    if (!tlTitle.trim()) return;
    setBusy(true);
    try {
      await api.post(`/api/projects/${project!.id}/timeline`, {
        storyTime: tlTime.trim(),
        title: tlTitle.trim(),
        chapterId: tlChapter || null,
      });
      setTlTitle('');
      setTlTime('');
      setTlChapter('');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function removeEvent(id: string) {
    if (!confirm('删除这条时间线事件？')) return;
    setBusy(true);
    try {
      await api.del(`/api/timeline/${id}`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function runCheck() {
    setBusy(true);
    setReport(null);
    try {
      const r = await api.post<ConsistencyReport>(
        `/api/projects/${project!.id}/consistency-check`,
      );
      setReport(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const openCount = foreshadows.filter((f) => f.status === 'planted').length;

  return (
    <Modal open={open} onClose={onClose} title="设定中心" wide>
      <div className="ai-tabs" style={{ padding: '0 0 10px', borderBottom: '1px solid var(--border)' }}>
        <button className={tab === 'brainstorm' ? 'active' : ''} onClick={() => setTab('brainstorm')}>
          脑暴
        </button>
        <button className={tab === 'foreshadow' ? 'active' : ''} onClick={() => setTab('foreshadow')}>
          伏笔台账{openCount > 0 ? `（${openCount}）` : ''}
        </button>
        <button className={tab === 'timeline' ? 'active' : ''} onClick={() => setTab('timeline')}>
          时间线
        </button>
        <button className={tab === 'knowledge' ? 'active' : ''} onClick={() => setTab('knowledge')}>
          知识库{docs.length > 0 ? `（${docs.length}）` : ''}
        </button>
        <button className={tab === 'toc' ? 'active' : ''} onClick={() => setTab('toc')}>
          AI 生成目录
        </button>
        <button className={tab === 'check' ? 'active' : ''} onClick={() => setTab('check')}>
          一致性检查
        </button>
      </div>

      {/* ── AI 生成目录 ── */}
      {tab === 'toc' && (
        <div className="settings-section">
          <p className="hint" style={{ marginTop: 0 }}>
            用书名、简介、脑暴板、现有章节和设定，让 AI 规划卷章目录（含每章大纲）。
            先预览，确认后才会追加写入，不会删你已有的章节。
          </p>

          <div className="row">
            <div className="field" style={{ flex: 1 }}>
              <label>规划章数</label>
              <input
                type="number"
                min={1}
                max={1000}
                value={tocCount}
                onChange={(e) => setTocCount(e.target.value)}
              />
            </div>
            <div className="field" style={{ flex: 3 }}>
              <label>额外要求（可空）</label>
              <input
                value={tocInstruction}
                onChange={(e) => setTocInstruction(e.target.value)}
                placeholder="如：前半段校园、后半段商战；每 5 章一个小高潮"
              />
            </div>
          </div>

          <label
            className="hint"
            style={{
              display: 'flex',
              gap: 6,
              alignItems: 'center',
              margin: '0 0 8px',
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={tocTitlesOnly}
              onChange={(e) => setTocTitlesOnly(e.target.checked)}
            />
            只生成章节名（快数倍，不写大纲；后期用下面「补全缺失大纲」一键补）
          </label>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
            <button className="primary" onClick={() => void genToc()} disabled={tocBusy}>
              {tocBusy && !tocPlan ? '生成中…' : '生成目录预览'}
            </button>
            {tocPlan && (
              <>
                <span className="hint" style={{ margin: 0 }}>
                  {tocPlan.volumes.length} 卷 / {tocPlan.chapters.length} 章
                </span>
                <button onClick={() => void applyToc()} disabled={tocBusy}>
                  写入目录
                </button>
              </>
            )}
          </div>

          {tocBusy && (
            <div className="empty" style={{ padding: '8px 0' }}>
              {tocJob
                ? `正在规划目录：已完成 ${tocJob.done}/${tocJob.total} 批${
                    tocJob.total > 0
                      ? `（${Math.min(100, Math.round((tocJob.done / tocJob.total) * 100))}%）`
                      : ''
                  }${tocJob.phase === 'planning' ? ' · 正在定骨架' : ''}`
                : '已提交后台任务，等待开始…'}
              <br />
              1000 章大约需要 30-60 分钟，可以先去忙别的，这个页面别关。
            </div>
          )}

          {tocPlan && (
            <div className="draft-outline" style={{ maxHeight: 320 }}>
              {tocPlan.volumes.map((v, vi) => (
                <div key={`${v.title}-${vi}`}>
                  <div className="draft-volume">{v.title}</div>
                  {tocPlan.chapters
                    .filter((c) => c.volumeIndex === vi)
                    .map((c, ci) => (
                      <div className="draft-chapter" key={`${c.title}-${ci}`}>
                        <div className="draft-chapter-title">{c.title}</div>
                        <div className="summary">{c.outline}</div>
                      </div>
                    ))}
                </div>
              ))}
              {tocPlan.chapters.filter(
                (c) => c.volumeIndex >= tocPlan.volumes.length || c.volumeIndex < 0,
              ).length > 0 && (
                <div className="draft-volume">
                  未归属卷的章节：
                  {tocPlan.chapters
                    .filter((c) => c.volumeIndex >= tocPlan.volumes.length || c.volumeIndex < 0)
                    .map((c) => c.title)
                    .join('、')}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── 补全缺失大纲 ── */}
      {tab === 'toc' && (
        <div className="settings-section" style={{ marginTop: 12 }}>
          <h3 style={{ fontSize: 13, margin: '0 0 4px' }}>补全缺失大纲</h3>
          <p className="hint" style={{ marginTop: 0 }}>
            目录只出名字时，章节没有大纲。点这个会找出所有**大纲为空**的章节，按批补齐（每批 10 章）。
          </p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button onClick={() => void fillOutlines()} disabled={fillBusy}>
              {fillBusy ? '补全中…' : '补全缺失大纲'}
            </button>
            {fillBusy && fillJob && (
              <span className="hint" style={{ margin: 0 }}>
                已完成 {fillJob.done}/{fillJob.total} 批
              </span>
            )}
          </div>
        </div>
      )}

      {/* ── 按卷扩展 ── */}
      {tab === 'toc' && (
        <div className="settings-section" style={{ marginTop: 12 }}>
          <h3 style={{ fontSize: 13, margin: '0 0 4px' }}>按卷扩展（扩到千章就用这个）</h3>
          <p className="hint" style={{ marginTop: 0 }}>
            已有 {chapters.length} 章
            {chapters.length < 1000
              ? `，按每卷 ${Number(exCount) || 50} 章算，还差约 ${Math.ceil(
                  (1000 - chapters.length) / (Number(exCount) || 50),
                )} 卷`
              : '，已满 1000 章'}
            。每卷生成完立即写入，某卷失败只影响那一卷，不用从头再来。
          </p>

          <div className="row">
            <div className="field" style={{ flex: 1 }}>
              <label>目标卷</label>
              <select value={exVolumeId} onChange={(e) => setExVolumeId(e.target.value)}>
                <option value="">＋ 新建一卷</option>
                {volumes.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.title}
                  </option>
                ))}
              </select>
            </div>
            <div className="field" style={{ flex: 2 }}>
              <label>{exVolumeId ? '卷名（取所选卷）' : '新卷卷名'}</label>
              <input
                value={exVolumeTitle}
                onChange={(e) => setExVolumeTitle(e.target.value)}
                placeholder={exVolumeId ? '' : '如：第三卷 · 商战风云（留空自动起名）'}
                disabled={Boolean(exVolumeId)}
              />
            </div>
            <div className="field">
              <label>本卷章数</label>
              <input
                type="number"
                min={1}
                max={300}
                value={exCount}
                onChange={(e) => setExCount(e.target.value)}
              />
            </div>
          </div>
          <div className="field">
            <label>本卷额外要求（可空）</label>
            <input
              value={exInstruction}
              onChange={(e) => setExInstruction(e.target.value)}
              placeholder="如：这一卷主线是夺回产业，结尾留一个反杀钩子"
            />
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
            <button className="primary" onClick={() => void genVolume()} disabled={exBusy}>
              {exBusy && !exPlan ? '生成中…' : '生成本卷章节'}
            </button>
            {exPlan && (
              <>
                <span className="hint" style={{ margin: 0 }}>
                  {exPlan.volumeTitle} · {exPlan.chapters.length} 章
                </span>
                <button onClick={() => void applyVolume()} disabled={exBusy}>
                  写入本卷
                </button>
              </>
            )}
          </div>

          {exBusy && (
            <div className="empty" style={{ padding: '6px 0' }}>
              {exJob
                ? `正在生成本卷：已完成 ${exJob.done}/${exJob.total} 批`
                : '已提交后台任务，等待开始…'}
            </div>
          )}

          {exPlan && (
            <div className="draft-outline" style={{ maxHeight: 260 }}>
              <div className="draft-volume">
                {exPlan.volumeTitle}（第 {chapters.length + 1}–{chapters.length + exPlan.chapters.length}{' '}
                章）
              </div>
              {exPlan.chapters.map((c, i) => (
                <div className="draft-chapter" key={`${c.title}-${i}`}>
                  <div className="draft-chapter-title">{c.title}</div>
                  <div className="summary">{c.outline}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── 脑暴 ── */}
      {tab === 'brainstorm' && (
        <div className="settings-section">
          <p className="hint" style={{ marginTop: 0 }}>
            零散的灵感、点子、对话片段都丢这里，不要求结构。之后可以据此整理大纲。
          </p>
          <div className="field">
            <textarea
              rows={10}
              value={brainstorm}
              onChange={(e) => setBrainstorm(e.target.value)}
              placeholder={
                '想到什么写什么，例如：\n- 主角的剑其实是他父亲的脊椎\n- 想写一场雨夜的对峙，两人都不说真话\n- 第三卷让女主先背叛一次'
              }
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button className="primary" onClick={() => void saveBrainstorm()} disabled={busy}>
              保存脑暴
            </button>
          </div>
        </div>
      )}

      {/* ── 知识库 ── */}
      {tab === 'knowledge' && (
        <div className="settings-section">
          <p className="hint" style={{ marginTop: 0 }}>
            上传设定集、参考文档、风格样本（.txt / .md）。写作时会按本章大纲自动检索相关片段注入，
            并在提示词里标明「作者资料」来源——模型自由发挥的内容不会和你的设定混为一谈。
          </p>

          <div className="field">
            <label>上传文件（.txt / .md）</label>
            <input type="file" accept=".txt,.md,.markdown" onChange={(e) => void onPickFile(e)} />
          </div>

          <div className="row">
            <div className="field" style={{ flex: 1 }}>
              <label>或直接粘贴资料标题</label>
              <input value={kTitle} onChange={(e) => setKTitle(e.target.value)} placeholder="如：世界观设定集" />
            </div>
            <div className="field" style={{ flex: 2 }}>
              <label>来源标注（可空）</label>
              <input value={kSource} onChange={(e) => setKSource(e.target.value)} placeholder="如：作者笔记.md" />
            </div>
          </div>
          <div className="field">
            <label>资料内容</label>
            <textarea
              rows={4}
              value={kContent}
              onChange={(e) => setKContent(e.target.value)}
              placeholder="粘贴设定、参考文本或风格样本…"
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
            <button
              className="primary"
              onClick={() => void addDoc(kContent, kTitle, kSource)}
              disabled={busy || !kContent.trim()}
            >
              ＋ 加入知识库
            </button>
          </div>

          <div className="field">
            <label>检索测试（确认写作时会引用到哪些片段）</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="输入关键词，如：北境 塔"
                style={{ flex: 1 }}
              />
              <button onClick={() => void doSearch()} disabled={!query.trim()}>
                检索
              </button>
            </div>
          </div>

          {hits.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              {hits.map((h, i) => (
                <div className="scene-card" key={`${h.docId}-${h.chunkIndex}-${i}`}>
                  <div className="scene-head">
                    <span className="tag">{h.score} 分</span>
                    <span className="scene-title">
                      {h.docTitle}
                      {h.source ? ` · ${h.source}` : ''}
                    </span>
                  </div>
                  <div className="scene-row">{h.text.slice(0, 200)}</div>
                </div>
              ))}
            </div>
          )}

          {docs.length === 0 && <div className="empty">知识库还是空的</div>}
          {docs.map((d) => (
            <div className="profile-row" key={d.id}>
              <div className="profile-main">
                <div className="profile-name">
                  {d.title}
                  <span className="tag">{d.chunkCount} 段</span>
                </div>
                <div className="profile-meta">
                  {d.source || '未标来源'} · {d.content.length} 字
                </div>
              </div>
              <div className="profile-actions">
                <button
                  className="danger"
                  style={{ padding: '3px 10px', fontSize: 12 }}
                  disabled={busy}
                  onClick={() => void removeDoc(d.id)}
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── 伏笔 ── */}
      {tab === 'foreshadow' && (
        <div className="settings-section">
          <p className="hint" style={{ marginTop: 0 }}>
            记录埋了什么坑、计划在哪回收。**未回收的伏笔会自动注入 AI 写作上下文**，让它记得呼应。
          </p>

          <div className="profile-editor" style={{ borderTop: 'none', paddingTop: 0, marginTop: 0 }}>
            <div className="row">
              <div className="field" style={{ flex: 2 }}>
                <label>伏笔内容</label>
                <input
                  value={fsTitle}
                  onChange={(e) => setFsTitle(e.target.value)}
                  placeholder="如：父亲临终前提到的「北境那座塔」"
                />
              </div>
              <div className="field">
                <label>计划回收</label>
                <select value={fsPlanned} onChange={(e) => setFsPlanned(e.target.value)}>
                  <option value="">未定</option>
                  {chapters.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="row">
              <div className="field" style={{ flex: 2 }}>
                <label>补充说明（可空）</label>
                <input
                  value={fsDetail}
                  onChange={(e) => setFsDetail(e.target.value)}
                  placeholder="希望怎么回收、有什么约束"
                />
              </div>
              <div className="field">
                <label>埋在哪章</label>
                <select value={fsPlanted} onChange={(e) => setFsPlanted(e.target.value)}>
                  <option value="">未指定</option>
                  {chapters.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="primary" onClick={() => void addForeshadow()} disabled={busy || !fsTitle.trim()}>
                ＋ 添加伏笔
              </button>
            </div>
          </div>

          {foreshadows.length === 0 && <div className="empty">还没有记录伏笔</div>}

          {foreshadows.map((f) => (
            <div className={`profile-row${f.status === 'planted' ? ' active' : ''}`} key={f.id}>
              <div className="profile-main">
                <div className="profile-name">
                  {f.title}
                  <span className="tag">{STATUS_LABEL[f.status]}</span>
                  {f.importance >= 3 && <span className="pin">核心</span>}
                </div>
                <div className="profile-meta">
                  {f.plantedChapterId
                    ? `埋于 ${chapterTitle.get(f.plantedChapterId) ?? '未知章'}`
                    : '埋点未指定'}
                  {f.plannedChapterId
                    ? ` · 计划回收于 ${chapterTitle.get(f.plannedChapterId) ?? '未知章'}`
                    : ''}
                  {f.detail ? ` · ${f.detail}` : ''}
                </div>
              </div>
              <div className="profile-actions">
                {f.status !== 'recovered' && (
                  <button
                    style={{ padding: '3px 10px', fontSize: 12 }}
                    disabled={busy}
                    onClick={() => void setStatus(f, 'recovered')}
                  >
                    标记已回收
                  </button>
                )}
                {f.status === 'recovered' && (
                  <button
                    style={{ padding: '3px 10px', fontSize: 12 }}
                    disabled={busy}
                    onClick={() => void setStatus(f, 'planted')}
                  >
                    撤销回收
                  </button>
                )}
                <button
                  className="danger"
                  style={{ padding: '3px 10px', fontSize: 12 }}
                  disabled={busy}
                  onClick={() => void removeForeshadow(f.id)}
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── 时间线 ── */}
      {tab === 'timeline' && (
        <div className="settings-section">
          <p className="hint" style={{ marginTop: 0 }}>
            记录故事里发生的关键事件与时间点，检查时会用来发现时间线矛盾。
          </p>

          <div className="row">
            <div className="field" style={{ flex: 2 }}>
              <label>事件</label>
              <input
                value={tlTitle}
                onChange={(e) => setTlTitle(e.target.value)}
                placeholder="如：林尘夺得试剑第一"
              />
            </div>
            <div className="field">
              <label>故事内时间</label>
              <input
                value={tlTime}
                onChange={(e) => setTlTime(e.target.value)}
                placeholder="第三年·冬"
              />
            </div>
            <div className="field">
              <label>对应章节</label>
              <select value={tlChapter} onChange={(e) => setTlChapter(e.target.value)}>
                <option value="">未指定</option>
                {chapters.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button className="primary" onClick={() => void addEvent()} disabled={busy || !tlTitle.trim()}>
              ＋ 添加事件
            </button>
          </div>

          {timeline.length === 0 && <div className="empty">还没有时间线事件</div>}

          {timeline.map((t) => (
            <div className="profile-row" key={t.id}>
              <div className="profile-main">
                <div className="profile-name">
                  <span className="tag">{t.storyTime || '未标时间'}</span>
                  {t.title}
                </div>
                <div className="profile-meta">
                  {t.chapterId ? chapterTitle.get(t.chapterId) ?? '未知章' : '未关联章节'}
                </div>
              </div>
              <div className="profile-actions">
                <button
                  className="danger"
                  style={{ padding: '3px 10px', fontSize: 12 }}
                  disabled={busy}
                  onClick={() => void removeEvent(t.id)}
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── 一致性检查 ── */}
      {tab === 'check' && (
        <div className="settings-section">
          <p className="hint" style={{ marginTop: 0 }}>
            把设定、伏笔、时间线和最近章节一起交给 AI，找出人物突变、时间线矛盾、设定吃书、称呼不一致、伏笔有埋无收等问题。
          </p>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
            <button className="primary" onClick={() => void runCheck()} disabled={busy}>
              {busy ? '检查中…' : '开始检查'}
            </button>
            <span className="hint" style={{ margin: 0 }}>
              会消耗一次较长请求，章节多时需要 30-60 秒
            </span>
          </div>

          {report && (
            <>
              <div className="hint" style={{ marginBottom: 8 }}>
                检查范围：{report.scope.chapters} 章 / {report.scope.entities} 条设定 /{' '}
                {report.scope.foreshadows} 条伏笔 / {report.scope.timeline} 条时间线
                {report.issues.length === 0 ? ' · 未发现明显问题' : ` · 发现 ${report.issues.length} 个问题`}
              </div>
              {report.issues.map((issue, i) => (
                <IssueCard key={i} issue={issue} />
              ))}
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

function IssueCard({ issue }: { issue: ConsistencyIssue }) {
  return (
    <div className={`issue-card sev-${issue.severity}`}>
      <div className="issue-head">
        <span className={`issue-sev sev-${issue.severity}`}>{SEVERITY_LABEL[issue.severity]}</span>
        <span className="tag">{KIND_LABEL[issue.kind] ?? issue.kind}</span>
        <span className="issue-title">{issue.title}</span>
      </div>
      {issue.detail && <div className="issue-detail">{issue.detail}</div>}
      {issue.suggestion && <div className="issue-suggest">建议：{issue.suggestion}</div>}
      {issue.refs.length > 0 && <div className="issue-refs">涉及：{issue.refs.join('、')}</div>}
    </div>
  );
}
