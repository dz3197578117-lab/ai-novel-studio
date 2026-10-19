/**
 * NovelForge 领域模型与 API 契约（唯一事实来源）
 *
 * 规则：前端与后端都只从这里导入类型。
 * 改这里的类型 = 改前后端契约，必须同步更新 zod schema。
 */

// ─────────────────────────── 通用 ───────────────────────────

export interface Timestamped {
  createdAt: string; // ISO 8601
  updatedAt: string;
}

export type ID = string;

export interface ApiError {
  error: string;
  message: string;
  details?: unknown;
}

export interface Paginated<T> {
  items: T[];
  total: number;
}

// ─────────────────────────── 项目 ───────────────────────────

export type ProjectStatus = 'drafting' | 'paused' | 'finished' | 'archived';

export interface Project extends Timestamped {
  id: ID;
  title: string;
  /** 一句话简介 */
  logline: string;
  genre: string;
  /** 目标字数，0 表示不限 */
  targetWords: number;
  status: ProjectStatus;
  /** 默认文风设定（注入到每次生成） */
  styleGuide: string;
}

/** 作品库列表项：附统计信息，供「小说管理」视图使用 */
export interface ProjectOverview extends Project {
  chapterCount: number;
  wordCount: number;
  entityCount: number;
  /** 最近生成的封面图地址；没有则为 null */
  coverUrl: string | null;
}

// ─────────────────────────── 设定库 ───────────────────────────

export type EntityType = 'world' | 'character' | 'faction' | 'term' | 'item' | 'location';

export interface EntityField {
  key: string;
  value: string;
}

/**
 * 设定库条目。用「类型 + 结构化字段 + 自由正文」的方式，
 * 既能被 AI 精确引用，也能容纳无法预判的设定。
 */
export interface Entity extends Timestamped {
  id: ID;
  projectId: ID;
  type: EntityType;
  name: string;
  /** 别名/尊称/代称，用于一致性检测 */
  aliases: string[];
  /** 一句话摘要，注入 prompt 时优先用它以节省 token */
  summary: string;
  /** 结构化属性，如 { 年龄: '27', 阵营: '青云宗' } */
  fields: EntityField[];
  /** 详细设定正文（Markdown） */
  body: string;
  /** 是否默认注入到生成上下文 */
  pinned: boolean;
}

// ─────────────────────────── 大纲 / 卷章 ───────────────────────────

export interface Volume extends Timestamped {
  id: ID;
  projectId: ID;
  title: string;
  summary: string;
  order: number;
}

export interface ChapterSummary {
  id: ID;
  projectId: ID;
  volumeId: ID | null;
  title: string;
  order: number;
  wordCount: number;
  status: ChapterStatus;
  updatedAt: string;
}

export type ChapterStatus = 'outline' | 'drafting' | 'revising' | 'done';

export interface Chapter extends Timestamped {
  id: ID;
  projectId: ID;
  volumeId: ID | null;
  title: string;
  order: number;
  /** 章节大纲/梗概，AI 写作的主要依据 */
  outline: string;
  /** 正文，Markdown */
  content: string;
  status: ChapterStatus;
  wordCount: number;
  /** 本章的长期记忆摘要，写完由 AI 生成，供后续章节注入 */
  summary: string;
}

// ─────────────────────────── AI 配置与生成 ───────────────────────────

export interface AiProviderConfig {
  /** OpenAI 兼容的 Base URL，如 https://api.deepseek.com/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

export type ImageProviderConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

export interface Settings {
  text: AiProviderConfig;
  image: ImageProviderConfig;
  /** 是否暴露给前端读取（apiKey 永远打码） */
  hasTextKey: boolean;
  hasImageKey: boolean;
}

export type WriteMode =
  | 'continue'   // 续写
  | 'rewrite'    // 改写选中片段
  | 'polish'     // 润色
  | 'expand'     // 扩写
  | 'style';     // 仿写指定风格

export interface WriteRequest {
  projectId: ID;
  chapterId: ID;
  mode: WriteMode;
  /** 用户额外指令 */
  instruction?: string;
  /** 续写/改写时的选中文本或光标前文 */
  selection?: string;
  /** 记忆注入的最大字数预算 */
  memoryBudget?: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 流式事件：SSE 传输，每行 `data: <json>\n\n` */
export type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'meta'; promptTokens?: number; memoryUsed: MemoryUsage[] }
  | { type: 'done'; fullText: string; usage?: TokenUsage }
  | { type: 'error'; message: string };

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface MemoryUsage {
  kind: 'entity' | 'chapter-summary' | 'volume-summary' | 'style';
  label: string;
  chars: number;
}

// ─────────────────────────── 导出 ───────────────────────────

export type ExportFormat = 'txt' | 'md' | 'docx';

export interface ExportRequest {
  projectId: ID;
  format: ExportFormat;
  /** 空数组 = 全部章节 */
  chapterIds?: ID[];
  /** 是否包含章节大纲 */
  includeOutline?: boolean;
}

// ─────────────────────────── 图片 ───────────────────────────

export interface ImageRequest {
  projectId: ID;
  prompt: string;
  size?: string;
}

export interface GeneratedImage extends Timestamped {
  id: ID;
  projectId: ID;
  prompt: string;
  /** 相对 server data 目录的路径，如 /files/images/xxx.png */
  url: string;
  kind: 'cover' | 'illustration';
  chapterId: ID | null;
}
