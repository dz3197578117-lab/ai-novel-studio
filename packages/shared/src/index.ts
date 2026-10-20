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

/**
 * 叙述视角。
 * auto = 不注入守则，由文风与正文自行推断（老作品保持原行为）。
 */
export type NarrativePov = 'auto' | 'first' | 'third-limited' | 'third-omniscient' | 'multi';

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
  /** 脑暴板：零散的灵感、点子、聊天记录（Markdown） */
  brainstorm?: string;
  /**
   * 硬约束（考据规则 / 制度设定 / 写作禁令）。
   * 与「设定条目」不同：这里是作者写死的规则，每次生成和检查都会强制带上。
   */
  rules?: string;
  /** 叙述视角设定 */
  pov?: NarrativePov;
  /** 视角补充规则：限知跟谁、多视角怎么切 */
  povNote?: string;
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
  /** 细纲：把本章大纲拆成逐拍的动作/冲突（Markdown） */
  beats?: string;
  /** 写作前归纳的待核实事实点，生成时用来检索作者资料 */
  facts?: FactPoint[];
  /**
   * 本章视角覆盖；null 表示继承项目默认。
   * 楔子、序章、尾声这类特殊章节可以单独设成别的视角。
   */
  pov?: NarrativePov | null;
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

/**
 * 一套模型配置（一个服务商）。
 * 可以存多套，随时切换当前使用哪一套。
 */
export interface ModelProfile extends Timestamped {
  id: ID;
  /** 显示名，如「DeepSeek 官方」「本地 Ollama」 */
  name: string;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

/** 返回给前端的版本：不包含真实 Key，只给打码值 */
export interface ModelProfilePublic extends ModelProfile {
  apiKeyMasked: string;
  hasApiKey: boolean;
}

export interface ModelProfileInput {
  name: string;
  baseUrl: string;
  /** undefined = 不修改（编辑时），'' = 清空，掩码值 = 保留，其他 = 新 Key */
  apiKey?: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

export interface Settings {
  profiles: ModelProfilePublic[];
  /** 当前生效的配置 id；null 表示还没选 */
  activeProfileId: ID | null;
  image: ImageProviderConfig;
  hasImageKey: boolean;
}

/** 拉取某个服务商的可用模型列表 */
export interface FetchModelsRequest {
  baseUrl: string;
  /** 直接给 Key（新配置还没保存时用） */
  apiKey?: string;
  /** 或者指定已保存的配置，从库里取 Key */
  profileId?: ID;
}

export type WriteMode =
  | 'continue'        // 续写
  | 'rewrite'         // 改写选中片段
  | 'polish'          // 润色
  | 'expand'          // 扩写
  | 'style'           // 仿写指定风格
  | 'chapter'         // 按大纲写整章正文（从零）
  | 'chapter-rewrite'; // 重写整章正文（参考现有版本）

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

// ─────────────────────────── 分层创作：场景卡 ───────────────────────────

/** 场景卡：把一章拆成若干可写的场景 */
export interface Scene extends Timestamped {
  id: ID;
  projectId: ID;
  chapterId: ID;
  order: number;
  /** 场景标题，如「祠堂除名」 */
  title: string;
  /** 视角人物 */
  pov: string;
  location: string;
  /** 场景目标：这一场要达成什么 */
  goal: string;
  /** 冲突/阻力 */
  conflict: string;
  /** 结果与钩子 */
  outcome: string;
  /** 场景里想用的关键台词 */
  keyLines: string;
}

export interface SceneInput {
  title: string;
  pov?: string;
  location?: string;
  goal?: string;
  conflict?: string;
  outcome?: string;
  keyLines?: string;
}

// ─────────────────────────── 知识库 ───────────────────────────

/** 作者资料（设定集/参考文档/风格样本） */
export interface KnowledgeDoc extends Timestamped {
  id: ID;
  projectId: ID;
  title: string;
  /** 来源标记，如「设定集.txt」 */
  source: string;
  tags: string[];
  /** 纯文本内容 */
  content: string;
  chunkCount: number;
}

export interface KnowledgeDocInput {
  title: string;
  source?: string;
  tags?: string[];
  content: string;
}

/** 检索命中的片段，用于引用溯源 */
export interface KnowledgeHit {
  docId: ID;
  docTitle: string;
  source: string;
  chunkIndex: number;
  text: string;
  score: number;
}

// ─────────────────────────── 一致性引擎 ───────────────────────────

export type ForeshadowStatus = 'planted' | 'recovered' | 'abandoned';

/** 伏笔台账：埋了什么、在哪章、计划何时回收 */
export interface Foreshadow extends Timestamped {
  id: ID;
  projectId: ID;
  title: string;
  detail: string;
  /** 埋点所在章节 */
  plantedChapterId: ID | null;
  /** 计划回收的章节 */
  plannedChapterId: ID | null;
  /** 实际回收的章节 */
  recoveredChapterId: ID | null;
  status: ForeshadowStatus;
  /** 1=次要 2=重要 3=核心 */
  importance: number;
}

export interface ForeshadowInput {
  title: string;
  detail?: string;
  plantedChapterId?: ID | null;
  plannedChapterId?: ID | null;
  recoveredChapterId?: ID | null;
  status?: ForeshadowStatus;
  importance?: number;
}

/** 时间线事件 */
export interface TimelineEvent extends Timestamped {
  id: ID;
  projectId: ID;
  /** 故事内时间描述，如「第三年·冬」 */
  storyTime: string;
  title: string;
  detail: string;
  chapterId: ID | null;
  importance: number;
}

export interface TimelineInput {
  storyTime?: string;
  title: string;
  detail?: string;
  chapterId?: ID | null;
  importance?: number;
}

export type IssueSeverity = 'low' | 'medium' | 'high';
export type IssueKind =
  | 'character'    // 人物性格/动机突变
  | 'timeline'     // 时间线矛盾
  | 'setting'      // 设定吃书
  | 'naming'       // 称呼/姓名不一致
  | 'plot'         // 情节逻辑
  | 'foreshadow'   // 伏笔问题
  | 'history'      // 史实 / 制度 / 常识错误
  | 'pov'          // 人称 / 视角不一致（含叙述中自呼姓名）
  | 'other';

export interface ConsistencyIssue {
  kind: IssueKind;
  severity: IssueSeverity;
  /** 一句话说清问题 */
  title: string;
  /** 具体说明：哪里矛盾、和什么冲突 */
  detail: string;
  /** 可操作的修改建议 */
  suggestion: string;
  /** 涉及章节标题或设定名，便于定位 */
  refs: string[];
}

export interface ConsistencyReport {
  issues: ConsistencyIssue[];
  /** 参与检查的章节数、设定数等，便于判断检查范围 */
  scope: {
    chapters: number;
    entities: number;
    foreshadows: number;
    timeline: number;
  };
  createdAt: string;
  /** 本次检查有多少条 high 级问题被沉淀为「写作约束」（不重复计数） */
  syncedConstraints?: number;
}

// ─────────────────────────── AI 生成整本小说 ───────────────────────────

/** 对话式需求访谈中的一条消息 */
export interface InterviewMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** AI 在访谈中的一步回应 */
export interface InterviewReply {
  /** 给用户看的话（可能是一个问题，也可能是确认） */
  say: string;
  /** 可直接点选的快捷选项，没有则为空数组 */
  options: string[];
  /** 是否已经聊清楚、可以生成方案了 */
  done: boolean;
  /** done 为 true 时，供下游生成方案用的完整需求描述 */
  brief: string;
}

/** 用户对想要的小说提出的需求 */
export interface DraftRequest {
  /** 自由描述：想写什么故事 */
  idea: string;
  /** 题材倾向，留空由 AI 决定 */
  genre?: string;
  /** 目标章数，默认 10 */
  chapterCount?: number;
}

export interface DraftEntity {
  type: EntityType;
  name: string;
  aliases?: string[];
  summary: string;
  fields?: EntityField[];
  body?: string;
  pinned?: boolean;
}

export interface DraftVolume {
  title: string;
  summary: string;
}

export interface DraftChapter {
  /** 属于第几卷（对应 volumes 数组下标） */
  volumeIndex: number;
  title: string;
  outline: string;
}

/** AI 产出的小说方案（尚未落库，供用户预览/确认） */
export interface NovelDraft {
  title: string;
  logline: string;
  genre: string;
  styleGuide: string;
  /** AI 建议的叙述视角；用户可在方案预览里改，建书时写入 */
  pov?: NarrativePov;
  povNote?: string;
  entities: DraftEntity[];
  volumes: DraftVolume[];
  chapters: DraftChapter[];
}

/** 单独重新生成某一章的大纲 */
export interface ChapterRegenRequest {
  /** 整本需求（可空） */
  idea?: string;
  /** 书名，让新章节贴合基调 */
  title: string;
  logline?: string;
  volumes: { title: string; summary: string }[];
  /** 当前全部章节，用于取上下文 */
  chapters: { volumeIndex: number; title: string; outline: string }[];
  /** 要重做第几章（从 0 开始） */
  index: number;
  /** 额外要求，如「这一章要更紧张」 */
  instruction?: string;
}

export interface ChapterRegenReply {
  volumeIndex: number;
  title: string;
  outline: string;
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
  /**
   * rule = 作者硬约束 / 视角守则 / 检查沉淀的约束
   * plan = 大纲 / 细纲 / 场景卡
   * entity = 设定、伏笔、时间线、资料引用
   */
  kind: 'entity' | 'chapter-summary' | 'volume-summary' | 'style' | 'rule' | 'plan';
  label: string;
  chars: number;
}

// ─────────────────────────── 版本与更新 ───────────────────────────

export type UpdateStatus =
  | 'up-to-date' // 与远程 main 一致
  | 'behind' // 远程有更新
  | 'ahead' // 本地领先（开发者自己提交了还没推）
  | 'diverged' // 两边都有独立提交
  | 'no-git' // 压缩包安装，没有 git 历史
  | 'offline' // 连不上 GitHub
  | 'error'; // 其他（仓库不存在、限流等）

/** 本机当前安装的版本（不联网） */
export interface CurrentVersion {
  version: string;
  /** 短 sha；没有 git 时为 null */
  commit: string | null;
  date: string | null;
  branch: string | null;
  /** 是否可能通过 git 原地升级 */
  canPull: boolean;
}

export interface UpdateInfo {
  /** 本地当前版本 */
  current: CurrentVersion;
  /** 远程最新提交；查询失败时为 null */
  latest: {
    commit: string;
    short: string;
    date: string;
    message: string;
    url: string;
  } | null;
  status: UpdateStatus;
  behindBy: number | null;
  aheadBy: number | null;
  /** owner/repo，解析不到时为 null */
  repo: string | null;
  checkedAt: string;
  message?: string;
}

/** 需要在本章核实的事实点 */
export interface FactPoint {
  /** 一句话说明要核实什么，如「明代皇子称谓」 */
  point: string;
  /** 拿去检索知识库的关键词 */
  query: string;
  /** 是否属于「写错就是硬伤」的必查项 */
  mustHave?: boolean;
}

/** 写作前的事实核查单 */
export interface FactSheet {
  points: FactPoint[];
  /** 知识库命中片段；同一段资料可能同时回答多个事实点，所以用数组 */
  hits: {
    forPoints: string[];
    docTitle: string;
    source: string;
    text: string;
  }[];
  generatedAt: string;
}

/** 一致性检查沉淀下来的写作约束：下一章起生效，直到标记已解决 */
export interface WritingConstraint {
  id: ID;
  projectId: ID;
  chapterId: ID | null;
  text: string;
  severity: IssueSeverity;
  status: 'open' | 'resolved';
  createdAt: string;
  updatedAt: string;
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
