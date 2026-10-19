/**
 * 极简后台任务表。
 *
 * 为什么需要：1000 章目录要分 100 批生成，总时长可能几十分钟。
 * 挂在单个 HTTP 请求上，浏览器/代理会先超时断开，用户永远拿不到结果。
 * 改成「立刻返回 jobId，后台跑，前端轮询进度」。
 *
 * 只存在内存里：本机单用户场景够用，服务重启则任务丢失（可重新发起）。
 */

export type JobStatus = 'running' | 'done' | 'error';

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
  status: JobStatus;
  progress: JobProgress;
  result?: T;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

const jobs = new Map<string, Job<unknown>>();
/** 最多保留多少个任务记录，防止长跑后内存堆积 */
const MAX_JOBS = 30;

export function createJob<T>(kind: string, initial?: Partial<JobProgress>): Job<T> {
  const ts = new Date().toISOString();
  const job: Job<T> = {
    id: crypto.randomUUID(),
    kind,
    status: 'running',
    progress: { phase: 'planning', done: 0, total: 0, ...initial },
    createdAt: ts,
    updatedAt: ts,
  };
  jobs.set(job.id, job as Job<unknown>);

  // 清理老任务
  if (jobs.size > MAX_JOBS) {
    const sorted = [...jobs.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    for (const old of sorted.slice(0, jobs.size - MAX_JOBS)) {
      jobs.delete(old.id);
    }
  }
  return job;
}

export function patchJob(
  id: string,
  patch: Partial<Pick<Job, 'status' | 'error' | 'result'>> & { progress?: Partial<JobProgress> },
): void {
  const job = jobs.get(id);
  if (!job) return;
  if (patch.status) job.status = patch.status;
  if (patch.error !== undefined) job.error = patch.error;
  if (patch.result !== undefined) job.result = patch.result;
  if (patch.progress) job.progress = { ...job.progress, ...patch.progress };
  job.updatedAt = new Date().toISOString();
}

export function getJob<T = unknown>(id: string): Job<T> | null {
  return (jobs.get(id) as Job<T> | undefined) ?? null;
}

/** 后台执行；不阻塞请求，失败写进任务状态 */
export function runJob<T>(job: Job<T>, task: () => Promise<T>): void {
  void (async () => {
    try {
      const result = await task();
      patchJob(job.id, { status: 'done', result });
    } catch (e) {
      patchJob(job.id, { status: 'error', error: (e as Error).message || '任务失败' });
    }
  })();
}
