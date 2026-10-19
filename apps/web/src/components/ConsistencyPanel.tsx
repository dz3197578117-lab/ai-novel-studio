import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ConsistencyIssue,
  ConsistencyReport,
  Foreshadow,
  TimelineEvent,
} from '@novelforge/shared';
import { useNovel } from '../store/novel';
import { api } from '../api/client';
import { Modal } from './Modal';

type Tab = 'foreshadow' | 'timeline' | 'check';

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

  const [tab, setTab] = useState<Tab>('foreshadow');
  const [foreshadows, setForeshadows] = useState<Foreshadow[]>([]);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [busy, setBusy] = useState(false);

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
      const [fs, tl] = await Promise.all([
        api.get<Foreshadow[]>(`/api/projects/${project.id}/foreshadows`),
        api.get<TimelineEvent[]>(`/api/projects/${project.id}/timeline`),
      ]);
      setForeshadows(fs);
      setTimeline(tl);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [project, setError]);

  useEffect(() => {
    if (!open) return;
    setTab('foreshadow');
    setReport(null);
    void load();
  }, [open, load]);

  if (!project) return null;

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
        <button className={tab === 'foreshadow' ? 'active' : ''} onClick={() => setTab('foreshadow')}>
          伏笔台账{openCount > 0 ? `（${openCount}）` : ''}
        </button>
        <button className={tab === 'timeline' ? 'active' : ''} onClick={() => setTab('timeline')}>
          时间线
        </button>
        <button className={tab === 'check' ? 'active' : ''} onClick={() => setTab('check')}>
          一致性检查
        </button>
      </div>

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
