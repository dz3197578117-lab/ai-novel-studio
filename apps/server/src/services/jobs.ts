/**
 * 后台任务：落库 + 可取消 + 部分结果保留。
 *
 * 为什么需要落库：1000 章目录要分 100 批生成，总时长可能几十分钟。
 * 以前只放内存，任何一批失败、服务重启或用户关掉页面，前面跑的全白费。
 * 现在每次进度/结果都写 SQLite，页面重开还能把已生成的部分捡回来。
 *
 * 注意：这里只保证「结果不丢 + 可取消」，不做进程重启后自动续跑；
 * 重启时会把 running 标成 interrupted，用户可基于已有部分重新发起。
 */
import type { DatabaseSync } from 'node:sqlite';
import { getDb, nowIso } from '../db.js';

export type JobStatus = 'running' | 'done' | 'error' | 'canceled' | 'interrupted';

export interface JobProgress {
  /** 当前阶段：planning / chapters / finalizing */
  phase: string;
  done: number;
  total: number;
  /** 给人看的补充说明 */
  note?: string;
}

export interface Job<T = unknown> {
  id: string;
  kind: string;
  /** 所属作品；没有则为 null */
  projectId: string | null;
  status: JobStatus;
  progress: JobProgress;
  result?: T;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

interface JobRow {
  id: string;
  kind: string;
  project_id: string | null;
  status: JobStatus;
  progress: string;
  result: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

const jobs = new Map<string, Job<unknown>>();
const controllers = new Map<string, AbortController>();

/** 内存里最多保留多少个任务对象，防止长跑后堆积 */
const MAX_JOBS = 30;
/** 数据库里保留多少条历史任务（含结果，便于页面重开恢复） */
const MAX_DB_JOBS = 60;
/** 同时跑的任务上限：连点会撞服务商限流，超出的排队 */
const MAX_CONCURRENT_JOBS = 2;
let activeJobs = 0;
const waiting: Array<() => void> = [];

function rowToJob<T>(r: JobRow): Job<T> {
  let progress: JobProgress = { phase: 'planning', done: 0, total: 0 };
  try {
    const p = JSON.parse(r.progress) as Partial<JobProgress>;
    progress = { ...progress, ...p };
  } catch {
    /* 脏数据当默认值 */
  }
  let result: T | undefined;
  if (r.result) {
    try {
      result = JSON.parse(r.result) as T;
    } catch {
      result = undefined;
    }
  }
  return {
    id: r.id,
    kind: r.kind,
    projectId: r.project_id,
    status: r.status,
    progress,
    result,
    error: r.error ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function persist(job: Job<unknown>): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO job_runs (id, kind, project_id, status, progress, result, error, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       status = excluded.status,
       progress = excluded.progress,
       result = excluded.result,
       error = excluded.error,
       updated_at = excluded.updated_at`,
  ).run(
    job.id,
    job.kind,
    job.projectId,
    job.status,
    JSON.stringify(job.progress),
    job.result === undefined ? null : JSON.stringify(job.result),
    job.error ?? null,
    job.createdAt,
    job.updatedAt,
  );
}

function pruneDb(): void {
  const db = getDb();
  db.prepare(
    `DELETE FROM job_runs
     WHERE status <> 'running'
       AND id NOT IN (SELECT id FROM job_runs ORDER BY created_at DESC LIMIT ?)`,
  ).run(MAX_DB_JOBS);
}

export function createJob<T>(
  kind: string,
  initial?: Partial<JobProgress>,
  projectId: string | null = null,
): Job<T> {
  const ts = nowIso();
  const job: Job<T> = {
    id: crypto.randomUUID(),
    kind,
    projectId,
    status: 'running',
    progress: { phase: 'planning', done: 0, total: 0, ...initial },
    createdAt: ts,
    updatedAt: ts,
  };
  jobs.set(job.id, job as Job<unknown>);
  persist(job as Job<unknown>);
  pruneDb();

  if (jobs.size > MAX_JOBS) {
    const finished = [...jobs.values()]
      .filter((j) => j.status !== 'running')
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    for (const old of finished.slice(0, jobs.size - MAX_JOBS)) jobs.delete(old.id);
  }
  return job;
}

export function patchJob(
  id: string,
  patch: Partial<Pick<Job, 'status' | 'error' | 'result'>> & { progress?: Partial<JobProgress> },
): void {
  const job = jobs.get(id) ?? getJob(id);
  if (!job) return;

  // 已取消/已中断的任务，后台残留的完成回调不许把它改回 done
  const terminal =
    job.status === 'canceled' || job.status === 'interrupted';
  if (patch.status && (!terminal || patch.status === 'canceled')) job.status = patch.status;
  if (patch.error !== undefined) job.error = patch.error;
  if (patch.result !== undefined) job.result = patch.result;
  if (patch.progress) job.progress = { ...job.progress, ...patch.progress };
  job.updatedAt = nowIso();

  jobs.set(job.id, job);
  persist(job);
}

export function getJob<T = unknown>(id: string): Job<T> | null {
  const mem = jobs.get(id);
  if (mem) return mem as Job<T>;
  const row = getDb().prepare('SELECT * FROM job_runs WHERE id = ?').get(id) as
    | JobRow
    | undefined;
  return row ? rowToJob<T>(row) : null;
}

/** 某个作品最近的任务，供页面重开后恢复「上次生成到哪了」 */
export function listJobs(projectId: string, kind?: string, limit = 10): Job[] {
  const rows = kind
    ? (getDb()
        .prepare(
          `SELECT * FROM job_runs WHERE project_id = ? AND kind = ?
           ORDER BY created_at DESC LIMIT ?`,
        )
        .all(projectId, kind, limit) as unknown as JobRow[])
    : (getDb()
        .prepare('SELECT * FROM job_runs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?')
        .all(projectId, limit) as unknown as JobRow[]);
  return rows.map((r) => rowToJob(r));
}

/**
 * 取消任务：中断正在进行的请求，状态标为 canceled。
 * 已生成的部分结果保留在 job.result 里，前端仍可预览/应用。
 */
export function cancelJob(id: string): Job | null {
  const job = getJob(id);
  if (!job) return null;
  if (job.status === 'running') {
    controllers.get(id)?.abort();
    job.status = 'canceled';
    job.error = '已取消';
    job.updatedAt = nowIso();
    jobs.set(id, job);
    persist(job);
  }
  return job;
}

/** 进程启动时调用：上次没跑完的任务不可能自动继续，标出来让用户看部分结果 */
export function markRunningJobsInterrupted(): void {
  const db: DatabaseSync = getDb();
  const ts = nowIso();
  db.prepare(
    `UPDATE job_runs SET status = 'interrupted',
       error = COALESCE(error, '服务重启，任务已中断；已生成的部分仍可查看'),
       updated_at = ?
     WHERE status = 'running'`,
  ).run(ts);

  // 内存里也同步：getJob 优先读内存，只改库的话同一进程里仍会看到 running
  for (const job of jobs.values()) {
    if (job.status === 'running') {
      job.status = 'interrupted';
      job.error = job.error ?? '服务重启，任务已中断；已生成的部分仍可查看';
      job.updatedAt = ts;
    }
  }
}

function abortError(): Error {
  const e = new Error('任务已取消');
  e.name = 'AbortError';
  return e;
}

/** 后台执行；不阻塞请求。失败/取消写进任务状态，已产生的 result 不清空 */
export function runJob<T>(job: Job<T>, task: (signal: AbortSignal) => Promise<T>): void {
  const controller = new AbortController();
  controllers.set(job.id, controller);

  const start = () => {
    if (controller.signal.aborted || getJob(job.id)?.status === 'canceled') {
      controllers.delete(job.id);
      // 排队期间被取消：没占并发名额，要把后面的任务放行，否则队列会卡住
      waiting.shift()?.();
      return;
    }
    activeJobs++;
    void (async () => {
      try {
        const result = await task(controller.signal);
        if (controller.signal.aborted) throw abortError();
        patchJob(job.id, { status: 'done', result });
      } catch (e) {
        const aborted = controller.signal.aborted || (e as Error).name === 'AbortError';
        if (aborted) {
          patchJob(job.id, { status: 'canceled', error: '已取消' });
        } else {
          // 关键：不清空 result。前面批次已经 patch 进去的部分要留给用户
          patchJob(job.id, { status: 'error', error: (e as Error).message || '任务失败' });
        }
      } finally {
        controllers.delete(job.id);
        activeJobs--;
        waiting.shift()?.();
      }
    })();
  };

  if (activeJobs < MAX_CONCURRENT_JOBS) {
    start();
    return;
  }

  patchJob(job.id, {
    progress: { ...job.progress, note: `排队中（已有 ${activeJobs} 个任务在跑）` },
  });
  waiting.push(start);
}
