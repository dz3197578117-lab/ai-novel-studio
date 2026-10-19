# 开发指南

面向要改这个项目的人。目标：**改一处，不牵连别处**。

## 三条铁律

1. **类型只从 `packages/shared` 导入。** 前端、后端都不许自己定义领域模型。改契约 = 改 `shared/src/index.ts`，编译器会告诉你哪些地方要跟着改。
2. **SQL 只在 `repos/` 里写。** 路由里不出现 `SELECT`/`INSERT`。换数据库时只动 `repos/`。
3. **AI 提示词只在 `ai/context.ts` 里拼。** 想让 AI 更懂你的设定，改这一个文件，别处不用碰。

## 目录职责

| 路径 | 职责 | 什么时候改 |
| --- | --- | --- |
| `packages/shared/src/index.ts` | 领域模型 + API 契约 | 加字段、加枚举、加请求/响应类型 |
| `apps/server/src/db.ts` | 建表、迁移、字数统计 | 加表、加列（用 `user_version` 迁移） |
| `apps/server/src/repos/*.ts` | 数据访问 | 加查询、改 SQL |
| `apps/server/src/routes/*.ts` | 校验 + 响应 | 加接口 |
| `apps/server/src/routes/schemas.ts` | zod 校验 | 加接口时同步加 schema |
| `apps/server/src/ai/client.ts` | 模型调用（OpenAI 兼容） | 换厂商、加参数 |
| `apps/server/src/ai/context.ts` | **上下文拼装（核心）** | 调记忆策略、改提示词 |
| `apps/web/src/store/novel.ts` | 全局状态 | 加数据源 |
| `apps/web/src/components/*` | 视图 | 改界面 |

## 常见任务

### 模型配置是怎么存的

跟 DeepSeek Harness 类似：**多套配置 + 一个当前生效的 id**。

- `settings` 表里是两个 key：`profiles`（JSON 数组，含真实 apiKey）、`activeProfileId`
- `repos/settings.repo.ts` 是唯一入口：`getProfiles / createProfile / updateProfile / deleteProfile / getActiveProfile`
- 模型调用一律走 `ai/client.ts` 的 `loadTextConfig()`，它取当前生效的那套并校验 Key
- **Key 永远不出后端**：接口返回 `apiKeyMasked`，前端回传掩码时 `resolveSecret()` 会保留原值
- 老版本只有一套 `settings.text`，`migrateLegacy()` 会自动转成一条配置，升级不掉 Key

新增配置相关接口时，记得同步 `packages/shared` 的 `ModelProfile*` 类型和 `schemas.ts`。

#### 复用 DSH 的 DeepSeek 登录（`repos/dsh.ts`）

`GET /api/dsh/status` 探测本机 `~/.dsh/.credentials.yaml`，`POST /api/dsh/import` 把里面的
`DEEPSEEK_API_KEY` 复制成一套配置（`https://api.deepseek.com/v1` + `deepseek-flash`）并设为当前。

边界很明确，改的时候别越界：

- **只读** DSH 的凭据文件，绝不写回；DSH 升级/退出不影响已导入的配置（各自独立一份 Key）
- 接口**只回打码值**，真实 Key 只存在于 NovelForge 的 `settings` 表
- 用 `DSH_HOME` 环境变量可指向别处，测试就是靠它注入假凭据
- DSH 里还有一个 `deepseek-account-platform` 的账号 token（issuer 是 platform.deepseek.com），
  那是网页端 OAuth 凭据，**不能**用于 API，所以导入只认 `*_API_KEY`

### 调整「AI 生成小说」的产出

流程分三步，改之前先弄清边界：

0. **对话访谈**（`POST /api/ai/interview`）
   - 提示词与解析在 `server/src/ai/interview.ts`
   - AI 必须返回 JSON：`{ say, options, done, brief }`；`done` 且 `brief` 非空才算聊清楚
   - `parseInterviewResponse()` 做了兜底：没给 brief 时 `done` 强制为 false，避免用空需求去生成
   - 前端 `AiNovelDialog` 负责气泡对话与快捷选项
1. **生成方案**（`POST /api/ai/draft`）
   - 提示词在 `server/src/ai/draft.ts` 的 `buildDraftPrompt()`
   - 模型输出由 `parseDraft()` 清洗：去代码块、截取 JSON、类型兜底、越界卷号归零、超量截断
   - **不落库**，只返回给前端预览
2. **创建作品**（`POST /api/projects/from-draft`）
   - 校验用 `schemas.ts` 的 `novelDraftSchema`
   - 依次创建项目 → 设定 → 卷 → 章节，`volumeIndex` 映射到真实卷 id

想改产出结构（比如加「金句」「章节钩子」字段）时，三处要同步：
`shared` 的 `NovelDraft` / `draft.ts` 的提示词与 normalize / `schemas.ts` 的校验。

> 模型返回 JSON 是不可靠的：可能包 ```json、加解释、字段类型写错、卷号越界。
> 所有兜底都在 `parseDraft()` 里，新增字段时务必也在那里补 normalze，不要直接信任模型输出。

### 加一个设定类型（比如「功法」）

1. `shared/src/index.ts`：`EntityType` 加 `'technique'`
2. `server/src/routes/schemas.ts`：`entityInput` 的 enum 加 `'technique'`
3. `server/src/routes/entities.routes.ts`：`TYPES` 数组加 `'technique'`
4. `web/src/components/EntityManager.tsx`：`TYPE_LABEL` 加一项
5. `server/src/ai/context.ts`：`ENTITY_LABEL` 加一项

编译器会提醒你漏了哪步。

### 加一种写作模式（比如「续写对白」）

1. `shared`：`WriteMode` 加 `'dialogue'`
2. `server/src/routes/schemas.ts`：`writeRequest` 的 enum 加 `'dialogue'`
3. `server/src/ai/context.ts`：`MODE_INSTRUCTION` 加一条指令
4. `web/src/components/AiPanel.tsx`：`MODES` 加一个标签

### 调整记忆注入策略

只改 `apps/server/src/ai/context.ts` 的 `buildContext()`。当前优先级：

```
固定设定 > 本卷摘要 > 前几章摘要 > 本章大纲 > 文风 > 正文结尾
```

`take()` 函数负责按预算扣减字符数。想加新来源，照现有 `blocks.push()` 的写法加即可。

### 加一个导出格式（比如 EPUB）

1. `shared`：`ExportFormat` 加 `'epub'`
2. `server/src/routes/schemas.ts`：`exportRequest` 的 enum 加
3. `server/src/routes/export.routes.ts`：加一个分支
4. `web/src/components/ExportDialog.tsx`：`FORMATS` 加一项

## 测试

```bash
pnpm test          # 46 个后端用例（Node 原生 test runner）
pnpm typecheck     # 全量类型检查
pnpm test:e2e      # 浏览器端到端（需先 pnpm dev）
```

### 为什么要用 Node 原生 test 而不是 vitest

`node:sqlite` 不在 `module.builtinModules` 的裸名列表里（只有 `node:sqlite` 形式），
旧版 Vite/vitest 会把它当 npm 包去解析然后失败。Node 24 自带的 `node:test` 没有这个问题，
而且零依赖，启动更快。

### 没有 API Key 怎么测 AI 链路

用内置的 mock 服务：

```bash
pnpm mock:llm                       # 终端 A，监听 8899
pnpm dev                            # 终端 B
# 设置页填：Base URL http://127.0.0.1:8899/v1，Key 任意，模型 mock-model
pnpm test:e2e:write                 # 验证完整写作闭环
```

## 踩过的坑（别重犯）

**1. SSE 流被立刻中断**

```ts
// 错误：Node 新版里请求体读完后 'close' 就触发，生成刚发出就被 abort
req.raw.on('close', () => controller.abort());

// 正确：监听响应流，且只在真的没写完时中断
reply.raw.on('close', () => {
  if (!reply.raw.writableEnded) controller.abort();
});
```

**2. API Key 无法清空**

空字符串曾被当成「未修改」而保留旧 Key，用户永远删不掉。现在的语义：

- `undefined` = 字段没提交 → 保留
- 含 `••••` = 前端回显的掩码 → 保留
- `''` = 用户主动清空 → 清空

见 `settings.routes.ts` 的 `resolveSecret()`。

**3. 端口冲突**

用户机器上 8787 可能被占用。后端会自动顺延端口并写入 `data/server-port`，
Vite 配置读取该文件自动跟随。不需要手动改端口。

**4. Windows 上临时目录删不掉**

SQLite WAL 文件释放有延迟，测试清理要重试。见 `api.test.ts` 的 `after()`。

**5. 正文区无法滚动（内容被裁掉）**

早期的做法是「textarea 高度跟随内容增长」+ `overflow: hidden`，靠 `onInput` 重算高度。
问题：章节切换是**程序赋值**，不会触发 `input` 事件，高度停在 `min-height`，
而 `overflow: hidden` 会把超出部分裁掉——用户看到的正文少了一截，滚轮也滚不动。

现在改为**固定高度 + 内部滚动**，不再依赖任何手动高度计算：

```css
.editor-body { overflow: hidden; display: flex; }         /* 外层不滚 */
.editor-inner { display: flex; flex-direction: column; min-height: 0; }
.fiction { flex: 1; min-height: 0; overflow-y: auto; }    /* 内层自己滚 */
```

原则：**能用 CSS 布局解决的问题，不要用 JS 去算高度**。任何「内容怎么进来」的路径
（切章、AI 回填、导入）都不会再被裁掉。

验证脚本：`node scripts/diagnose-scroll.mjs`（派发真实滚轮事件，检查 scrollTop 是否变化）。

**6. push 时报 `Failed to connect to github.com:443`**

这台机器的 DNS 有时把 `github.com` 解析到 `20.205.243.166`，该地址 443 不通，
而 GitHub 其它入口 IP 是通的（`api.github.com` 也正常，所以容易误以为是网络全断）。

用内置脚本自动挑一个可用 IP 再推送：

```bash
pnpm push
```

它先直连试一次，失败则探测候选 IP，用 `git -c http.curloptResolve=...` 完成推送。
手动方式同理：

```bash
git -c http.curloptResolve=github.com:443:140.82.112.3 push
```

**7. 编辑器保存文件导致 Vite 整个挂掉（EBUSY）**

VS Code、JetBrains 和多数自动化工具保存文件时是「先写 `.xxx.tmpdir/xxx.tmp`，再重命名」。
Vite 的文件监听器一旦 watch 到那个临时文件，会抛 `EBUSY: resource busy or locked` 并**直接退出**，
表现为页面突然连不上（ERR_CONNECTION_REFUSED），而终端里 Vite 已经死了。

已在 `vite.config.ts` 里忽略这类临时文件：

```ts
server: {
  watch: {
    ignored: ['**/.*.tmpdir/**', '**/*.tmp', '**/.DS_Store', '**/*.swp'],
  },
}
```

遇到「页面打不开但后端还活着」，先看 `scripts\dev.mjs` 的日志里有没有 EBUSY。

**8. 切章节丢正文**

早先自动保存是 1.2 秒防抖，切章时组件被卸载、定时器被清掉，最后几秒的输入就没了。
现在 `Editor` 维护一份编辑快照，切章时先把上一章的未保存内容 `PATCH` 回去，再加载新章；
另外加了 `Ctrl+S` 立即保存和离开页面前的浏览器提醒。

**9. 「生成方案」报 JSON 解析失败（推理模型吃满 max_tokens）**

真实案例：商汤 `deepseek-flash` 生成 6 章方案时报「模型返回的方案格式有误」。
抓原始返回才看清原因：

```
finish_reason: "length"                 ← 输出被截断
completion_tokens: 4096 / 4096          ← 顶到上限
completion_tokens_details.reasoning_tokens: 1327   ← 其中 1300+ 是思考
```

推理模型的**思考过程也算在 max_tokens 里**，配置里默认 4096 的话，
真正用来写 JSON 的只剩两千多 token，方案写到一半就断了，自然解析不出来。

现在的三层处理：

1. **扩大预算**：`draftBudget()` 至少给 8192（`routes/draft.routes.ts`）
2. **能救就救**：`repairTruncatedJson()` 退到最后一个完整元素处补括号，
   少几章也比整个失败好（前端会提示「你要求 N 章，AI 给了 M 章」）
3. **装不下就分批**：超过 `SINGLE_CALL_MAX_CHAPTERS`（10 章）时走
   骨架一次 + 章节按 `CHAPTER_BATCH_SIZE`（20 章）分批，见 `generateChunked()`

分批带来的两个坑也一并处理了：

- **限流**：连续请求会撞 `429 TPM exceeded`。`postWithRetry()` 按 `Retry-After`
  或指数退避重试（最多 4 次），批次之间再等 2.5 秒
- **章号从 1 重数**：模型每批都会写「第1章」。批次提示词改成给全局章号，
  并且 `renumberChapterTitle()` 在服务端兜底重编号

几个容量相关的常量都在 `ai/draft.ts`：

| 常量 | 值 | 作用 |
| --- | --- | --- |
| `MAX_CHAPTERS` | 1000 | 章数上限 |
| `SINGLE_CALL_MAX_CHAPTERS` | 10 | 超过就分批 |
| `CHAPTER_BATCH_SIZE` | 20 | 每批章节数 |
| `CHAPTERS_PER_VOLUME` | 40 | 每卷约多少章 |
| `MAX_VOLUMES` | 20 | 卷数上限 |
| `MAX_PREVIOUS_TITLES` | 15 | 分批提示词里只带最近 N 章标题（否则上千章会撑爆上下文） |

改这些值时注意：批次越大越容易触发截断，卷数上限也会连带影响 `novelDraftSchema` 的校验范围。

排查这类问题时用 `scripts/diagnose-provider.mjs`：它用当前生效配置直接请求一次，
打印 `finish_reason`、usage 和原文首尾，不改数据库。

**10. 作品被误删后无从恢复**

曾经出现过整个演示作品从库里消失、且没有任何备份可回滚的情况。
SQLite 删除是提交式的，删了就没了，只能从 WAL 的旧页面里捞残片（`scripts/salvage-wal.mjs` 干这个），
代价大且不保证完整。

现在有两道保险，见 `repos/backup.ts`：

- **定期备份**：服务启动时 + 每 6 小时把整个 `.db` 复制到 `data/backups/`，保留最近 10 份
- **删除留档**：`DELETE /api/projects/:id` 和 `/api/chapters/:id` 会先把完整内容写成
  `data/backups/deleted-*.json` 再执行删除

改删除逻辑时**不要绕过 `archiveDeleted()`**，否则等于拆掉保险。
恢复方式：停服务 → 用备份的 .db 覆盖 → 重启；或从 deleted-*.json 里把内容粘回界面。

**11. 长请求被服务商掐断（`terminated`）**

生成 20 章目录时服务端报 `生成目录失败：terminated`，76 秒就失败。
原因是那批请求走了**非流式** `/chat/completions`：20 章大纲要写 60 秒以上，
期间没有任何数据下行，服务商直接断开连接。5 章只花 17 秒所以没事。

修法：长请求一律走**流式累加**——`ai/client.ts` 的 `completeAccumulated()`，
内部复用 `streamChat`，把 delta 拼成完整文本。数据一直在流动，就不会触发空闲超时。

配套调整：

- `CHAPTER_BATCH_SIZE` 从 20 压到 10，单批耗时更短、失败面更小
- 生成方案 / 生成目录 / 单章重做 / 细纲 / 场景卡 / 一致性检查全部改用 `completeAccumulated`
- 只有「章节摘要」「需求访谈」这类短请求还留着非流式（`complete`）

**判断依据**：报错里出现 `terminated`、`ECONNRESET`、或耗时长但无输出，先怀疑非流式长请求。

**12. 上千章目录「生成不了」——单请求扛不住**

1000 章 = 100 批，每批 15-20 秒，总共 30 分钟以上。挂在单个 HTTP 请求上时：
浏览器 fetch 没超时但代理/连接会先断，用户看到的就是"卡住然后失败"。

现在改成**后台任务 + 轮询**（`services/jobs.ts`）：

- `POST /api/projects/:id/generate-toc` 立刻返回 `202 { jobId, batches }`
- 任务在服务端跑，每完成一批 `patchJob(job.id, { progress })`
- 前端每 2 秒 `GET /api/jobs/:id`，显示「已完成 X/Y 批」
- 结束时 job.result 里是完整目录，再走 apply-toc 落库

**注意**：任务只存在内存里，服务重启或关掉页面都拿不到结果（可重新发起）。
生成期间**别关那个标签页**，也不要重启服务。

新增长任务时优先套这个模式，不要把几十分钟的活压在一个请求里。

**13. 上千章应该「按卷」扩，不要一次生成**

整本 1000 章一次生成有两个问题：跑 30-60 分钟、任何一批失败整单作废。

`POST /api/projects/:id/expand-volume` 就是为此设计的：

- 只生成「某一卷」的章节（默认 50 章，最多 300），起点章号自动接在现有章节之后
- 生成完 `POST /api/projects/:id/apply-volume-chapters` 立刻写入，锁定成果
- 下一卷生成时会把已写入的章节标题带上，避免重复
- 模型每批会从「第1章」重数，服务端用 `renumberChapterTitle()` 统一成全书连续编号

扩到 1000 章的推荐节奏：50 章一卷 × 20 轮，每轮 2-4 分钟，失败只损失当前卷。

**14. 改了前端文件但页面没变（Vite 漏掉文件变更）**

用脚本/工具改写文件后，Vite 的 watcher 偶尔收不到事件，页面仍跑旧代码
（表现为：HTML 结构和你刚写的不一致，但控制台没有报错）。

排查：先看渲染出来的 DOM 是不是新结构。不是的话：

```powershell
(Get-Item "apps\web\src\components\Xxx.tsx").LastWriteTime = Get-Date
```

再刷新即可。必要时重启 `pnpm dev`。**改完前端一定要看一眼实际 DOM**，别只看代码。

## 数据库迁移

改表结构时：

1. 在 `db.ts` 的 `migrate()` 里加 `if (version < N) { ... version = N; }`
2. 用 `ALTER TABLE` 而不是改原 `CREATE`（老数据要能升级）
3. 不要删列——加新列并保留旧的

## 代码风格

- 注释用中文，解释**为什么**而不是**做了什么**
- 函数短，一个函数一件事
- 错误信息写给用户看（「请先在设置中填写 API Key」而不是「config missing」）
- 不加没必要的依赖——现在只有 fastify / zod / docx / react / zustand
