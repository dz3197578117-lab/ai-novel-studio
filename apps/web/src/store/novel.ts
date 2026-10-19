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
    set({ currentProjectId: id, loading: true, currentChapter: null });
    try {
      const [project, volumes, chapters, entities, images] = await Promise.all([
        api.get<Project>(`/api/projects/${id}`),
        api.get<Volume[]>(`/api/projects/${id}/volumes`),
        api.get<ChapterSummary[]>(`/api/projects/${id}/chapters`),
        api.get<Entity[]>(`/api/projects/${id}/entities`),
        api.get<GeneratedImage[]>(`/api/projects/${id}/images`).catch(() => []),
      ]);
      set({ project, volumes, chapters, entities, images });
      if (chapters.length > 0 && !get().currentChapter) {
        await get().loadChapter(chapters[0]!.id);
      }
    } catch (e) {
      set({ error: (e as Error).message });
    } finally {
      set({ loading: false });
    }
  },

  async loadChapter(id) {
    try {
      const chapter = await api.get<Chapter>(`/api/chapters/${id}`);
      set({ currentChapter: chapter });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  async refresh() {
    const id = get().currentProjectId;
    if (!id) return;
    try {
      const [volumes, chapters, entities, images] = await Promise.all([
        api.get<Volume[]>(`/api/projects/${id}/volumes`),
        api.get<ChapterSummary[]>(`/api/projects/${id}/chapters`),
        api.get<Entity[]>(`/api/projects/${id}/entities`),
        api.get<GeneratedImage[]>(`/api/projects/${id}/images`).catch(() => []),
      ]);
      set({ volumes, chapters, entities, images });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },
}));
