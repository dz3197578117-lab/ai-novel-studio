# NovelForge · AI 小说创作台

本地运行的 AI 长篇创作工作台。一条命令启动，浏览器里写小说；AI 负责续写、改写、润色，你负责故事。

## 快速开始

### Windows 一键启动（推荐）

双击 **`启动.bat`**，约 12 秒后浏览器会自动打开。写作时保持那个黑色窗口开着，关掉它即停止服务。

### 命令行启动

```bash
pnpm install      # 安装依赖
pnpm seed         # （可选）生成一部演示作品，先看看效果
pnpm dev          # 启动开发环境
```

打开 http://127.0.0.1:5173 ，会先看到**书架**（所有作品一览）。点某一本书进入写作台，左上角「← 书架」随时返回。

首次使用点 **⚙ 设置**，填入模型配置。

### 接入模型（OpenAI 兼容，任选其一）

| 服务 | Base URL | 模型名示例 |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o` |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-max` |
| 本地 Ollama | `http://127.0.0.1:11434/v1` | `qwen2.5:14b` |

换成任何实现了 `/chat/completions` 的服务都能直接用，**不需要改代码**。

### 生产模式（单进程，前后端合一）

```bash
pnpm build
NODE_ENV=production pnpm start
# 访问 http://127.0.0.1:8787
```

## 功能

- **书架（主页）** —— 打开软件先看到所有作品：卡片式列表、搜索、新建 / 编辑 / 删除，显示章数、字数、设定数与完成度；点书进入写作台
- **设定库** —— 世界观 / 人物 / 势力 / 名词 / 物品 / 地点；支持别名、结构化字段、正文；可"固定注入"到每次生成
- **卷章结构** —— 卷下分章，章节带大纲与状态；支持重命名、删除
- **AI 写作** —— 续写 / 改写 / 润色 / 扩写 / 仿写，SSE 流式输出，可随时停止
- **长期记忆** —— 自动把「固定设定 + 卷摘要 + 前几章摘要 + 本章大纲」拼进上下文，长篇不崩
- **导出** —— TXT / Markdown / Word（DOCX 带标题层级）
- **AI 配图** —— 封面与插图（需单独的图像模型）

首次启动会自动带入一部演示作品《长夜行》。运行 `pnpm seed` 可补齐演示数据（只补缺失项，不会覆盖你写的内容）。

## 快捷键

| 快捷键 | 作用 |
| --- | --- |
| `Ctrl + S` | 立即保存当前章节（平时也会自动保存） |
| `Ctrl + Enter` | 用当前模式生成正文 |
| `Esc` | 关闭弹窗 |
| 双击章节 / 卷标题 | 重命名 |

写作时左侧目录的章节和卷，鼠标悬停会出现 `✎`（重命名）和 `×`（删除）。

## 架构

```
novelforge/
├── packages/shared/          # 唯一的前后端契约：领域模型 + 类型
├── apps/server/              # Fastify + node:sqlite
│   └── src/
│       ├── ai/               # 模型客户端 + 上下文拼装（核心）
│       ├── repos/            # 数据访问，每个实体一个文件
│       ├── routes/           # 路由，按资源拆分
│       ├── db.ts             # 建表与迁移
│       └── config.ts         # 路径与端口
└── apps/web/                 # React + Vite + zustand
    └── src/
        ├── api/              # HTTP 与 SSE 客户端
        ├── store/            # 全局状态
        └── components/       # 视图组件
```

### 为什么这样分层

- **契约先行**：所有类型都在 `packages/shared`，前后端只从这里导入。改接口 = 改一个文件，TypeScript 会报出所有需要同步的地方。
- **AI 逻辑集中**：`ai/context.ts` 是「记忆注入」的唯一实现。想让 AI 更懂你的设定，只改这一个文件。
- **零原生依赖存储**：用 Node 24 内置的 `node:sqlite`，不用编译 better-sqlite3，换机器不折腾。
- **路由与仓储分离**：路由只管校验与响应，`repos/` 只管 SQL。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | 同时启动前后端（热更新） |
| `pnpm test` | 运行后端测试（46 个用例） |
| `pnpm typecheck` | 全量类型检查 |
| `pnpm build` | 构建前端产物 |
| `pnpm start` | 生产模式启动 |
| `pnpm seed` | 生成演示数据 |
| `pnpm test:e2e` | 浏览器端到端测试（需先 `pnpm dev`） |
| `pnpm mock:llm` | 启动模拟模型服务（无需 API Key 也能测） |
| `pnpm clean` | 清空构建产物与本地数据 |

开发细节、扩展方式、踩坑记录见 [DEVELOPMENT.md](./DEVELOPMENT.md)。

## 数据在哪

全部在 `apps/server/data/`：

- `novelforge.db` —— 作品、设定、章节（SQLite）
- `images/` —— 生成的图片
- `exports/` —— 导出缓存

**API Key 也存在这个库里，不会上传到任何地方。** 备份整个 `data/` 目录即可。

可用 `NOVELFORGE_DATA_DIR` 环境变量把数据放到别处。

## 上下文是怎么拼的

每次生成时，`buildContext()` 按优先级往提示词里塞内容，直到用完 token 预算（默认 6000 字符）：

1. 固定注入的设定条目（人物、世界观……）
2. 本卷摘要
3. 前几章摘要（越近越优先，最多 30 章）
4. 本章大纲（强制遵守）
5. 文风要求
6. 本章正文结尾 2500 字 / 或你选中的片段

想调整策略，改 `apps/server/src/ai/context.ts`。

## 扩展指引

- **加一个新的设定类型**：改 `shared` 里的 `EntityType`，在 `EntityManager.tsx` 的 `TYPE_LABEL` 加一项，其余自动生效。
- **加一种写作模式**：改 `shared` 的 `WriteMode`，在 `context.ts` 的 `MODE_INSTRUCTION` 加指令，在 `AiPanel.tsx` 的 `MODES` 加标签。
- **加一种导出格式**：改 `shared` 的 `ExportFormat`，在 `export.routes.ts` 加一个分支。
- **换数据库**：只需替换 `repos/` 下的实现，路由层不用动。
