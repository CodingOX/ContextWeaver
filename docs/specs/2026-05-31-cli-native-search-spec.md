# CLI Native Search Mode Spec

> 状态：Draft
> 日期：2026-05-31
> 作者：Codex
> 目标读者：CodeRecall 核心维护者、CLI/MCP 使用方

**一、背景**

当前项目同时提供 3 个入口：

- `coderecall index`
- `coderecall mcp`
- `coderecall search`

其中 `search` 命令并不是原生 CLI 语义，而是直接复用了 `handleCodebaseRetrieval()`。这意味着：

- 参数命名继承了 MCP 风格，如 `information_request`、`technical_terms`
- 返回值先被包装成 MCP `content[]`，CLI 再把文本取出来输出
- CLI 行为和协议适配层耦合，不利于后续扩展 `json` 输出、交互模式、批处理模式

需要强调：现有 `SearchService.buildContextPack(query)` 已经是协议无关的核心搜索能力。当前真正耦合在 MCP 层里的，不是搜索算法本身，而是搜索前后的编排逻辑，包括：

- 环境变量检查
- 默认 `.env` 创建
- `projectId` 生成
- `isProjectIndexed()` / `ensureIndexed()`
- 查询参数拼接
- 文本响应格式化

因此，本次改造的重点不是重写搜索核心，而是把这层“入口编排逻辑”从 `codebaseRetrieval.ts` 中抽成公共服务。

当前实现位置：

- CLI 入口：`index.ts`
- MCP 适配层：`codebaseRetrieval.ts`
- 搜索核心：`SearchService.ts`
- 扫描与增量判定：`scanner/index.ts`

**二、问题陈述**

现状可用，但存在 4 个明显结构问题：

1. CLI 复用了“带 MCP 包装”的函数，而不是复用纯搜索能力。
2. 核心搜索能力没有一个对 CLI/MCP 都自然的内部服务接口。
3. 新增 CLI 能力时，容易被 MCP 的输入输出格式牵着走。
4. 后续如果增加 HTTP API、TUI 或批处理工具，会继续复制这层协议耦合。

一句话概括：当前是“同一套协议无关搜索核心 + 一层耦合在 MCP 目录中的入口编排”，缺少一个真正的“协议无关编排服务层”。

**三、目标**

本次改造目标：

1. 将本地检索能力抽成原生内部服务，输入输出不携带 MCP 协议语义。
2. CLI `search` 直接调用内部服务，成为一等入口。
3. MCP 工具改为调用同一个内部服务，只负责协议适配。
4. 支持搜索阶段过滤，允许通过参数只搜索源码、不搜索文档。
5. 为后续增强 CLI 输出格式、搜索模式和自动化集成留出清晰边界。

**四、非目标**

本次不做以下事情：

1. 不修改混合检索算法本身。
2. 不调整增量索引、自愈机制、向量库写入逻辑。
3. 不新增交互式 TUI。
4. 不重新设计 MCP 工具 schema。
5. 不引入 watcher 模式或后台常驻索引守护进程。
6. 不通过修改索引白名单来“移除文档索引”；本次只做搜索阶段过滤，不改变文档是否入索引。

**五、设计原则**

1. 核心能力优先，协议适配后置。
2. CLI 和 MCP 共用同一套搜索编排，不复制业务逻辑。
3. 对现有 `search` 命令保持兼容优先，再逐步增强体验。
4. 先解决分层和接口问题，再谈参数扩展和显示优化。
5. 不为了“CLI 原生”而破坏现有 MCP 行为。
6. 搜索过滤优先在查询阶段生效，而不是通过破坏现有索引内容来达成。

**六、方案概览**

推荐方案：新增一层“原生搜索应用服务”，由 CLI 和 MCP 共同调用。

分层调整后如下：

```text
CLI 命令 / MCP Tool
        ↓
协议适配层
  - CLI 参数解析 / 输出格式化
  - MCP Schema / content[] / progress
        ↓
原生搜索应用服务
  - ensure indexed
  - build query
  - execute search
  - return structured result
        ↓
现有核心能力
  - scan()
  - SearchService
  - ContextPack / GraphExpand / FTS / VectorStore
```

**七、方案对比**

**方案 A：保留现状，仅在 CLI 外层继续补参数**

- 优点：改动最小，短期上线最快
- 缺点：CLI 继续依赖 MCP 包装，后续越改越别扭
- 结论：不推荐，技术债继续累积

**方案 B：抽公共原生服务，CLI/MCP 共同复用**

- 优点：边界清晰，兼容性好，后续易扩展
- 缺点：需要做一次接口重组和调用方迁移
- 结论：推荐，本 spec 采用该方案

**方案 C：彻底 CLI-first，MCP 改为调用 CLI 子进程**

- 优点：部署形态统一
- 缺点：性能差，日志/错误/进度透传复杂，工程上没有必要
- 结论：不推荐

**八、目标架构**

建议新增以下公共模块：

- `src/app/searchCodebase.ts`
- `src/app/ensureIndexed.ts`
- `src/app/ensureDefaultEnvFile.ts`

职责：

1. `searchCodebase.ts` 作为公共搜索编排入口，接收协议无关参数并执行搜索。
2. `ensureIndexed.ts` 承接搜索前索引前置逻辑，包括 `isProjectIndexed()` 与 `ensureIndexed()`。
3. `ensureDefaultEnvFile.ts` 负责缺失配置时的默认 `.env` 创建逻辑。
4. `generateProjectId()` 保持留在 `db/index.ts`，继续作为公共函数复用，不迁移。

建议模块归属如下：

| 模块/函数 | 目标位置 | 说明 |
|---|---|---|
| `searchCodebase()` | `src/app/searchCodebase.ts` | 公共搜索编排 |
| `ensureIndexed()` | `src/app/ensureIndexed.ts` | 搜索前自动索引入口 |
| `isProjectIndexed()` | `src/app/ensureIndexed.ts` | `ensureIndexed()` 内部辅助函数 |
| `ensureDefaultEnvFile()` | `src/app/ensureDefaultEnvFile.ts` | 配置初始化辅助逻辑 |
| `generateProjectId()` | `db/index.ts` | 现有公共函数，继续复用 |

建议接口：

```ts
export interface SearchCodebaseInput {
  repoPath: string;
  query: string;
  configOverride?: Partial<SearchConfig>;
  onProgress?: (current: number, total?: number, message?: string) => void;
}

export interface SearchCodebaseResult {
  projectId: string;
  query: string;
  contextPack: ContextPack;
}
```

这里公共服务只接收最终 `query` 字符串，不再保留 `information_request` / `technical_terms` 之类的协议痕迹。查询拼接逻辑保留在各自适配层：

- CLI 适配层负责将 `--query` / `--term` 组合成最终查询字符串
- MCP 适配层负责将 `information_request` / `technical_terms` 组合成最终查询字符串

这样公共服务接口最干净，也避免把某个入口协议的语义继续渗透到内部层。

**错误处理模型**

公共服务建议采用“抛异常，由入口适配层转换”的模式：

- 公共服务层：抛出语义明确的异常，不直接 `process.exit()`，也不返回 MCP 结构
- CLI 入口：`catch` 后输出文本错误或 JSON 错误，并设置退出码
- MCP 入口：`catch` 后转换成 `{ isError: true, content: [...] }`

建议至少定义以下错误类型：

```ts
class MissingEnvError extends Error {
  constructor(public missingVars: string[]) {
    super('Required environment variables are missing');
  }
}

class SearchExecutionError extends Error {}
```

其中：

- `MissingEnvError` 专门承载 Embedding/Reranker 缺失配置
- 其他索引/搜索失败先统一按普通异常处理，后续再按需要细分

**默认配置差异传递策略**

当前存在两套默认配置：

- 普通默认配置：来自 `config.ts` 中的 `DEFAULT_CONFIG`
- MCP Zen 配置：来自 `codebaseRetrieval.ts` 中的 `ZEN_CONFIG_OVERRIDE`

本 spec 采用以下传递策略：

1. `searchCodebase()` 不感知 `cli` / `mcp` 模式，不内置 mode 分支。
2. `searchCodebase()` 只接受可选的 `configOverride`。
3. CLI 不显式传配置时，沿用 `SearchService` 默认配置。
4. MCP 继续显式传入 `ZEN_CONFIG_OVERRIDE`。

这样做的原因是边界最清晰，公共服务不需要知道调用方身份；如果未来 CLI 也需要 `--zen` 或其他 profile，只需要入口层自行传覆盖配置。

**搜索阶段过滤设计**

当前项目现状是：

- `.md` 会被纳入允许扩展名白名单并进入索引
- `markdown` 会参与分片、FTS 和向量召回
- 现有入口没有“只搜源码、不搜文档”的参数

本次 spec 新增一项明确能力：**在不改变索引内容的前提下，通过搜索参数过滤掉文档类结果**。

推荐设计目标：

1. 文档继续保留在索引中，避免破坏现有通用检索能力。
2. 当调用方显式要求“只搜源码”时，在搜索阶段排除文档。
3. 过滤逻辑应同时作用于：
   - 向量召回
   - 词法召回
   - 上下文扩展
4. CLI 与 MCP 走同一套过滤抽象，避免出现“CLI 只过滤了一半”的行为偏差。

建议新增内部搜索选项：

```ts
export interface SearchCodebaseInput {
  repoPath: string;
  query: string;
  codeOnly?: boolean;
  configOverride?: Partial<SearchConfig>;
  onProgress?: (current: number, total?: number, message?: string) => void;
}
```

其中：

- `codeOnly: true` 表示排除文档类文件，只搜索源码/配置/脚本等非文档结果
- 默认 `false`，保持当前行为不变

为避免后续扩展受限，也可以在实现时直接设计成更通用的过滤结构：

```ts
export interface SearchScopeOptions {
  excludeLanguages?: string[];
  excludePathPrefixes?: string[];
}
```

但从当前需求出发，spec 推荐第一阶段先落地 `codeOnly?: boolean`，不要过度设计。

**文档类文件的判定规则**

第一阶段建议采用“按语言标识过滤”的方式，先覆盖最明确、最稳定的文档类型：

- `markdown`

也就是说：

- `.md` / `markdown` 在索引中仍然存在
- 但 `codeOnly=true` 时，不参与搜索结果

后续如果团队需要，再扩展更多文档类文件定义，例如：

- `txt`
- `rst`
- `adoc`

但这些类型当前并不都在现有白名单里，因此不应提前写进第一阶段承诺。

**过滤落点**

当前底层能力现状：

1. 向量检索底层 `vectorStore.search()` 已支持 `filter` 参数。
2. `Indexer.textSearch()` 也支持把 `filter` 继续透传给向量检索。
3. 词法检索（FTS）路径目前没有统一过滤抽象。

因此需要补一层统一搜索过滤器，建议新增：

- `src/search/filtering.ts`

职责：

1. 根据搜索参数构造过滤条件。
2. 为 `SearchService` 提供协议无关的排除规则描述。
3. 为词法召回和上下文扩展提供统一的文件排除判定函数。

建议接口：

```ts
export interface SearchFilter {
  excludeLanguages?: string[];
  excludePathPrefixes?: string[];
}
```

建议行为：

- `codeOnly=false` 时：
  - 不生成任何排除规则
- `codeOnly=true` 时：
  - `excludeLanguages` 包含 `markdown`

由 `SearchService` 内部负责把 `SearchFilter` 转换成具体后端所需的过滤形式：

- 向量召回时，转换成 LanceDB `where` 表达式
- 词法召回时，转换成 FTS 后置过滤逻辑
- 扩展链路时，转换成文件/语言判定逻辑

这样 `filtering.ts` 保持协议无关，不直接暴露 LanceDB 实现细节。

**在搜索流程中的应用位置**

搜索阶段过滤不能只挂在 CLI 层，否则会漏掉 FTS 或扩展链路。建议在以下位置统一应用：

1. `SearchService.vectorRetrieve()`
   - 将 `SearchFilter` 内部转换为底层向量检索 filter 后传给 `Indexer.textSearch()`
2. `SearchService.lexicalRetrieve()`
   - FTS 命中后，按统一过滤规则过滤文件/chunk
3. `GraphExpander`
   - 对 import / breadcrumb / neighbor 扩展出来的 chunk 再做一次统一过滤
4. `ContextPacker`
   - 理论上前面已经过滤，但这里可以作为最终兜底，不建议承担主过滤职责

这样可以保证：

- 初始召回不会把 markdown 当 seed
- 扩展阶段也不会把文档重新带回来

**CLI 参数设计**

CLI 增加显式开关：

```bash
coderecall search --query "认证流程" --code-only
```

语义：

- `--code-only`：搜索阶段排除文档类结果，只返回源码相关结果

这个参数与索引无关，不会删除任何已建立的文档索引。

**MCP 侧设计**

本次不修改现有 MCP schema 的必填字段结构，但建议为后续兼容预留可选参数：

```ts
code_only?: boolean
```

如果团队希望本轮只做 CLI，不暴露 MCP 侧参数，也可以接受；但内部过滤能力应设计成公共抽象，避免未来再拆一轮。

**为什么不在索引阶段排除文档**

因为这两个需求不是一回事：

1. “文档不要入库”
2. “某次搜索时不要搜文档”

当前用户需求是第 2 种。若直接通过 `.gitignore` / `IGNORE_PATTERNS` 在索引阶段排掉文档，会带来副作用：

- 文档检索能力彻底消失
- 不同仓库需要重新索引才能切换行为
- 无法做到“同一份索引，按场景切换是否看文档”

所以本次只做搜索阶段过滤，这是更合理的产品形态。

**九、模块职责调整**

**1. `searchCodebase.ts`**

新增内部服务，负责完整搜索编排。

**2. `codebaseRetrieval.ts`**

降级为 MCP 适配层，只做：

- schema 校验
- 将 `information_request + technical_terms` 拼接为最终 `query`
- 结构化结果转 MCP `content[]`
- MCP 风格错误返回

**3. `index.ts` 中的 `search` 命令**

改为直接调用 `searchCodebase()`，不再经过 `handleCodebaseRetrieval()`。

**4. 可选的输出格式化模块**

如果实现中发现 `index.ts` 太重，建议再拆：

- `src/cli/formatSearchText.ts`
- `src/cli/formatSearchJson.ts`

本次不是必须，但建议作为扩展点预留。

**5. 文本格式化逻辑的复用策略**

当前 `codebaseRetrieval.ts` 中已有 `formatMcpResponse()`，它本质上做了两件事：

1. 把 `ContextPack` 格式化成文本
2. 再把文本包装成 MCP `content[]`

本次改造建议把这两层拆开：

```text
ContextPack
   ↓
formatSearchText(pack)
   ↓
CLI: 直接输出文本
MCP: 包装为 { content: [{ type: 'text', text }] }
```

也就是说：

- 先抽一个协议无关的 `formatSearchText(pack)` 作为公共文本格式化器
- MCP 的 `formatMcpResponse()` 改为复用这个文本格式化器
- CLI 文本模式也复用同一份文本格式

这样能避免 CLI 和 MCP 出现两套逐渐漂移的文本布局。

**十、CLI 用法设计**

本次保持现有命令名 `search`，避免破坏用户习惯。

推荐保留并增强如下用法：

```bash
coderecall search \
  --repo-path /path/to/repo \
  --information-request "How is authentication flow handled?" \
  --technical-terms "AuthService,login"
```

在此基础上，规划以下 CLI 设计。

**1. 基础文本输出**

```bash
coderecall search \
  --information-request "Trace the login flow"
```

行为：

- 默认仓库路径为当前目录
- 默认先执行一次增量扫描
- 输出格式保持接近当前文本结果

源码限定模式：

```bash
coderecall search \
  --query "Trace the login flow" \
  --code-only
```

行为：

- 搜索阶段排除文档类结果
- 不影响索引内容
- 不会修改当前仓库下的文档索引

**2. JSON 输出**

```bash
coderecall search \
  --information-request "Trace the login flow" \
  --json
```

行为：

- 输出结构化 JSON
- 便于脚本、编辑器插件、CI 集成

建议返回字段：

```json
{
  "version": "1.0",
  "projectId": "abc123def0",
  "query": "Trace the login flow AuthService login",
  "seeds": [],
  "expanded": [],
  "segments": [],
  "meta": {
    "repoPath": "/repo",
    "indexedBeforeSearch": true
  }
}
```

对于错误输出，机读模式也应遵守结构化标准：
```json
{
  "version": "1.0",
  "success": false,
  "error": {
    "code": "INDEXING_FAILED",
    "message": "Permission denied"
  }
}
```

最终 JSON 字段名可在实现时再对齐 `ContextPack` 真实结构，但原则是：CLI 输出应该反映业务数据，而不是 MCP `content[]`。

**3. 索引策略开关**

建议预留以下选项，但可以分阶段落地：

```bash
coderecall search --information-request "..." --no-index
coderecall search --information-request "..." --force-index
```

语义建议：

- `--no-index`：跳过搜索前扫描，直接查询现有索引
- `--force-index`：强制重新扫描并重建当前仓库索引

说明：

- `--no-index` 对调试和离线对比很有用
- `--force-index` 适合怀疑索引漂移或大规模切分支后手工修复

本 spec 建议把这两个选项列入目标接口，但实现时可以先只做 `--json`，将索引策略开关放入第二阶段。

需要明确：`--no-index` / `--force-index` 属于“搜索流程编排层”的行为控制，不会修改 `scan()` 内部的增量索引算法，因此不与“非目标：不调整增量索引逻辑”冲突。

**4. 参数别名优化**

为提升 CLI 可读性，建议逐步增加别名：

```bash
coderecall search \
  --query "Trace the login flow" \
  --term AuthService \
  --term login
```

兼容建议：

- 第一阶段保留 `--information-request` 和 `--technical-terms`
- 新增更短的 CLI 别名
- 文档主推 CLI 原生命名，老参数继续可用

建议映射关系：

| CLI 参数 | 兼容状态 | 说明 |
|---|---|---|
| `--information-request` | 保留 | 与现有行为兼容 |
| `--query` | 新增推荐 | CLI 语义更自然 |
| `--technical-terms` | 保留 | 兼容旧用法 |
| `--term` | 新增推荐 | 可重复传入，更符合终端习惯 |
| `--code-only` | 新增推荐 | 搜索阶段排除文档，只返回源码相关结果 |

**十一、输出行为设计**

建议将输出层明确分为两种模式。

**1. 人读模式**

面向终端用户，保留当前文本格式，重点优化：

- 错误信息更直接
- 明确提示是否执行了索引
- 输出更稳定，便于复制

**2. 机读模式**

面向脚本调用，要求：

- 稳定 JSON schema
- 非日志污染
- 错误码清晰

建议约束：

- `--json` 时，标准输出只输出 JSON
- 日志写 stderr 或由日志级别控制

**十二、兼容性策略**

本次改造需要保持以下兼容：

1. `coderecall mcp` 行为不变。
2. 现有 `coderecall search` 基本参数继续可用。
3. 搜索结果核心语义不变，变化仅限入口分层和输出格式能力增强。
4. 自动增量扫描仍然默认开启。
5. 未显式开启 `--code-only` 时，文档仍会像现在一样参与搜索。

**十三、迁移步骤建议**

建议按 3 步落地。

**阶段 1：P0 基础重构**

- 新增 `searchCodebase.ts`
- 新增 `ensureIndexed.ts`
- 新增或拆出公共文本格式化器
- 将环境检查、索引前置、`SearchService` 调用从 `codebaseRetrieval.ts` 中拆出
- CLI 与 MCP 都改为走内部服务

说明：

- 本阶段只完成“公共编排层”重构。
- 本阶段不要求 `--code-only` 对外可用。
- 如果团队希望降低第二阶段风险，可在本阶段先把 `SearchFilter` 类型和传递链路预埋好，但不暴露 CLI 参数。

这是本次改造最核心的一步。

**阶段 2：P1 CLI 能力增强**

- `search` 命令增加 `--json`
- 逐步引入 `--query` / `--term`
- 增加 `--code-only`
- 文本输出与 JSON 输出分流

说明：

- `--code-only` 不是纯 CLI 表层改动，它会下沉到 `SearchService` / `GraphExpander` / 过滤基础设施。
- 因此如果第二阶段接入 `--code-only`，必须同步修改非 CLI 层代码。
- 也就是说，第二阶段是“CLI 参数 + 搜索核心过滤能力”一起落地，而不是只改命令行入口。

**阶段 3：补文档与稳定性验证**

- README 更新 CLI 样例
- 验证 CLI/MCP 结果一致性
- 验证默认索引行为未回退

**十四、测试策略**

本次改造虽然主要是分层，但仍建议补测试，覆盖以下方面：

1. CLI `search` 不再依赖 `handleCodebaseRetrieval()`。
2. MCP 与 CLI 调用同一内部服务。
3. 同一输入下，CLI 文本模式与 MCP 文本结果在语义上保持一致。
4. `--json` 输出结构稳定，且不混入额外日志。
5. 默认搜索前仍会执行 `ensureIndexed()`。
6. `--no-index` / `--force-index` 如果本轮实现，需要覆盖行为测试。
7. `--code-only` 开启时，Markdown 文档不会出现在 seeds、expanded 和最终输出中。
8. 未开启 `--code-only` 时，现有文档检索行为不回退。

建议测试类型：

- 单元测试：`searchCodebase.ts`
- 集成测试：CLI `search`
- 回归测试：MCP `codebase-retrieval`

**十五、风险与注意事项**

**1. 分层后结果格式可能出现轻微差异**

如果 CLI 不再直接消费 MCP 格式，文本输出很可能要重排。需要明确“结果语义兼容”优先于“字面文本逐字符一致”。

**2. 进度回调边界要保留**

MCP 目前依赖 `onProgress` 发通知。抽公共服务时不能把这条链路丢掉。

**3. 环境变量校验不能被埋进 CLI 专属逻辑**

因为 MCP 和 CLI 都依赖 Embedding/Reranker，环境校验应放在公共服务或公共前置层，而不是只在某个入口里做。

**4. JSON schema 不要直接暴露内部对象全部细节**

`ContextPack` 是内部结构，CLI JSON 输出建议做一层稳定映射，避免后续内部结构小改动导致外部消费方频繁破裂。

**5. 过滤必须覆盖扩展链路**

如果只过滤初始召回，不过滤 `GraphExpander`，那么源码 seed 仍可能把 `README.md` 或其他 Markdown 通过 import/breadcrumb/neighbor 重新带回来。实现时必须保证过滤在扩展链路也生效。

**十六、待评审问题**

以下问题建议团队在 review 时明确：

1. CLI 主命令是否继续使用 `search`，还是新增更短别名如 `ask`？
2. `--query` / `--term` 是立即主推，还是先只做兼容别名？
3. `--no-index` 是否允许绕过默认“搜索前自动增量扫描”？
4. CLI JSON 输出是否需要版本号字段，例如 `version` 或 `schemaVersion`？
5. `--json` 的 schema 是否需要在第一阶段就承诺稳定？
6. `--json` 的 schema 是否要从第一阶段开始承诺向后兼容，还是允许在 P1 阶段小幅调整？

**对 MCP `code_only` 的推荐意见**

本 spec 的推荐是：**本轮先只在 CLI 暴露 `--code-only`，MCP 不新增 `code_only` schema 字段。**

理由：

1. 当前用户需求来自 CLI 使用场景，优先满足本地终端检索即可。
2. 现有 MCP schema 保持不变，兼容性风险最低。
3. 内部过滤能力一旦统一完成，后续如需给 MCP 暴露参数，只需要增加适配层字段，而不需要重做核心实现。
4. 这样可以把“先做能力、后开协议口子”分成两步，降低评审和上线复杂度。

**十七、推荐结论**

推荐采用“抽公共原生搜索服务，CLI/MCP 双入口复用”的方案。

理由：

1. 改动面可控，不触碰检索核心算法。
2. 能解决当前 CLI 被 MCP 包装层牵制的问题。
3. 为后续 `json`、批处理、编辑器集成、HTTP API 预留清晰扩展点。
4. 不破坏现有 MCP 使用方。

**十八、最小落地范围**

如果团队希望把范围切得更清楚，本 spec 建议按优先级拆成两层。

**P0 最小落地范围**

1. 新增原生内部搜索服务。
2. 新增公共索引前置模块，承接 `ensureIndexed()` / `isProjectIndexed()`。
3. 抽取公共文本格式化器，供 CLI / MCP 共同复用。
4. CLI `search` 改走内部服务。
5. MCP 适配层改走内部服务。

**P1 增强范围**

1. CLI 新增 `--json`。
2. 搜索阶段新增 `--code-only` 过滤能力。
3. 引入 `SearchFilter` / `filtering.ts`。
4. 搜索核心链路接入统一过滤：
   - `vectorRetrieve`
   - `lexicalRetrieve`
   - `GraphExpander`
   - `ContextPacker` 兜底
5. 增加 `--query` / `--term` 等更自然的 CLI 别名。

这样分层后，P0 只解决“分层与复用”，P1 再解决“CLI 能力增强与搜索过滤”。

**简短总结**

这次不是重写 CLI，而是把现有“能用但协议耦合”的 CLI 搜索入口，升级成真正的原生 CLI 模式：

- 业务核心下沉为公共服务
- MCP 变适配层
- CLI 成为一等入口
- 后续扩展能力不再受 MCP 输出格式限制
