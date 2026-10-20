import { create } from 'zustand';
import type {
  Chapter,
  ChapterSummary,
  Entity,
  GeneratedImage,
  ID,
  Project,
  Volume,
} from '@novelforge/shared';
import { api } from '../api/client';

interface NovelState {
  // 数据
  projects: Project[];
  currentProjectId: ID | null;
  project: Project | null;
  volumes: Volume[];
  chapters: ChapterSummary[];
  entities: Entity[];
  images: GeneratedImage[];
  currentChapter: Chapter | null;

  // 状态
  loading: boolean;
  saving: boolean;
  error: string | null;

  // 动作
  loadProjects: () => Promise<void>;
  selectProject: (id: ID) => Promise<void>;
  /** 解除当前作品（删除当前作品后调用），配合 loadProjects 会自动选中下一本 */
  clearProject: () => void;
  /** 解除当前章节（删除当前章节后调用） */
  clearChapter: () => void;
  loadChapter: (id: ID) => Promise<void>;
  refresh: () => Promise<void>;
  setError: (msg: string | null) => void;
  clearError: () => void;
}

/**
 * 请求序号：只有「最新一次」请求的结果能写进 store。
 * 没有它的话，快速切章节/切作品时，先发后到的慢响应会覆盖当前内容——
 * 界面上显示的是 B 章，实际编辑与保存的却是 A 章。
 */
let chapterSeq = 0;
let projectSeq = 0;

/**
 * 单一 store：数据量小（一个项目几百章），不做细粒度拆分，
 * 保持逻辑简单。写操作后调用 refresh() 保证一致性。
 */
export const useNovel = create<NovelState>((set, get) => ({
  projects: [],
  currentProjectId: null,
  project: null,
  volumes: [],
  chapters: [],
  entities: [],
  images: [],
  currentChapter: null,
  loading: false,
  saving: false,
  error: null,

  setError: (msg) => set({ error: msg }),
  clearError: () => set({ error: null }),

  clearProject: () =>
    set({
      currentProjectId: null,
      project: null,
      volumes: [],
      chapters: [],
      entities: [],
      images: [],
      currentChapter: null,
    }),

  clearChapter: () => set({ currentChapter: null }),

  async loadProjects() {
    set({ loading: true });
    try {
      const projects = await api.get<Project[]>('/api/projects');
      set({ projects });
      if (!get().currentProjectId && projects.length > 0) {
        await get().selectProject(projects[0]!.id);
      }
    } catch (e) {
      set({ error: (e as Error).message });
    } finally {
      set({ loading: false });
    }
  },

  async selectProject(id) {
    const seq = ++projectSeq;
    chapterSeq++; // 作废在途的章节加载，避免旧项目的章节落回来
    set({ currentProjectId: id, loading: true, currentChapter: null });
    try {
      const [project, volumes, chapters, entities, images] = await Promise.all([
        api.get<Project>(`/api/projects/${id}`),
        api.get<Volume[]>(`/api/projects/${id}/volumes`),
        api.get<ChapterSummary[]>(`/api/projects/${id}/chapters`),
        api.get<Entity[]>(`/api/projects/${id}/entities`),
        api.get<GeneratedImage[]>(`/api/projects/${id}/images`).catch(() => []),
      ]);
      if (seq !== projectSeq) return; // 用户已经切到别的作品，丢弃这批结果
      set({ project, volumes, chapters, entities, images });
      if (chapters.length > 0 && !get().currentChapter) {
        await get().loadChapter(chapters[0]!.id);
      }
    } catch (e) {
      if (seq === projectSeq) set({ error: (e as Error).message });
    } finally {
      if (seq === projectSeq) set({ loading: false });
    }
  },

  async loadChapter(id) {
    const seq = ++chapterSeq;
    try {
      const chapter = await api.get<Chapter>(`/api/chapters/${id}`);
      if (seq !== chapterSeq) return; // 慢响应后到：丢弃，别覆盖当前章节
      set({ currentChapter: chapter });
    } catch (e) {
      if (seq === chapterSeq) set({ error: (e as Error).message });
    }
  },

  async refresh() {
    const id = get().currentProjectId;
    if (!id) return;
    const seq = projectSeq;
    try {
      const [volumes, chapters, entities, images] = await Promise.all([
        api.get<Volume[]>(`/api/projects/${id}/volumes`),
        api.get<ChapterSummary[]>(`/api/projects/${id}/chapters`),
        api.get<Entity[]>(`/api/projects/${id}/entities`),
        api.get<GeneratedImage[]>(`/api/projects/${id}/images`).catch(() => []),
      ]);
      if (seq !== projectSeq) return; // 期间切了作品，这批数据已过期
      set({ volumes, chapters, entities, images });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },
}));
