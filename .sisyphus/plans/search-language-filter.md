# 搜索语言过滤能力实施计划

## TL;DR

> **Quick Summary**: 为 `codebase-retrieval` 增加语言过滤参数（`source_code_only` / `include_languages` / `exclude_languages`），并将过滤前置到向量召回与 FTS 查询层，避免文档类结果挤占 TopK。
>
> **Deliverables**:
> - MCP 参数与冲突校验落地
> - SearchService 向量/词法召回 pre-filter 落地
> - `language.ts` 分类能力与白名单校验能力
> - FTS 子查询过滤与性能索引（`files.language`）
> - 覆盖单测与回归验证
>
> **Estimated Effort**: Medium
> **Parallel Execution**: 部分并行（2 波）
> **Critical Path**: 语言分类与规则 -> 查询层 pre-filter -> MCP 参数接入 -> 测试回归

---

## Context

### Original Request
基于 `.sisyphus/drafts/search-language-filter.md` 生成可执行工作记录/实施计划，目标是提供“按语言过滤搜索结果”的能力，尤其满足“只搜源码，不搜文档”。

### Interview Summary
- 用户痛点：`codebase-retrieval` 语义上会召回大量 markdown 文档，挤占源码结果名额。
- 既有能力：路径 glob 过滤已存在，但属于 post-filter，无法防止 TopK 被噪声占满。
- 已确认方向：新增 `source_code_only`、`include_languages`、`exclude_languages`。
- 关键约束：不改默认行为、尽量不改 schema、过滤必须 pre-filter。

### Metis Review（已吸收）
- 关键补洞 1：FTS 虚拟表无 `language` 列，需走子查询路径：`file_path IN (SELECT path FROM files WHERE language IN (...))`。
- 关键补洞 2：向量链路已支持 `filter` 透传（`Indexer.textSearch(query, limit, filter?)`），应复用现有能力。
- 关键补洞 3：`lexicalRetrieve` 两条路径（chunks_fts 与 files_fts fallback）都必须加语言过滤。
- 关键补洞 4：为 `files(language)` 增加索引，避免子查询退化。

---

## Work Objectives

### Core Objective
在不破坏默认搜索行为与索引兼容性的前提下，为 MCP 检索提供语言级过滤能力，并确保过滤在召回阶段前置生效。

### Concrete Deliverables
- `src/scanner/language.ts`：新增语言分类常量与辅助函数。
- `src/mcp/tools/codebaseRetrieval.ts`：新增参数 schema、冲突/白名单校验、参数传递。
- `src/search/types.ts`：扩展 `BuildContextPackOptions` 支持语言过滤参数。
- `src/search/SearchService.ts`：向量与词法召回接入 pre-filter。
- `src/search/fts.ts`：chunks_fts/files_fts 双路径接入语言子查询过滤。
- `src/db/index.ts`：新增 `idx_files_language` 索引。
- `tests/runtime/*`：新增/更新测试，覆盖分类、冲突、pre-filter、回归。

### Definition of Done
- [ ] `pnpm build` 通过
- [ ] `pnpm test` 通过
- [ ] 无过滤参数时结果行为与当前版本保持一致
- [ ] `source_code_only: true` 时 markdown/json/yaml/toml/xml 不进入召回结果
- [ ] include/exclude/source_code_only 冲突规则严格生效并返回明确错误

### Must Have
- pre-filter 在向量召回与 FTS 查询层生效。
- 参数冲突规则完整实现并可测试。
- SQL 拼接输入仅来自白名单语言集合，拒绝未知/恶意值。

### Must NOT Have (Guardrails)
- 不修改 FTS 虚拟表结构（`chunks_fts` / `files_fts`）。
- 不修改现有 `LANGUAGE_MAP` 映射语义。
- 不顺带改造 path glob pre-filter。
- 不新增 CLI 参数（仅 MCP 工具）。
- 不在 `SearchConfig` 中加入语言过滤配置（该能力应为运行时请求参数）。

---

## Verification Strategy

> **UNIVERSAL RULE: ZERO HUMAN INTERVENTION**
>
> 所有验收标准必须由执行代理自动完成，不依赖人工点击或人工目视确认。

### Test Decision
- **Infrastructure exists**: YES
- **Automated tests**: YES（Tests-after）
- **Framework**: `tsx` 执行测试脚本（`pnpm test` 串行）

### Agent-Executed QA Scenarios（全任务通用约束）

Scenario: 无参数回归行为不变
  Tool: Bash
  Preconditions: 项目已可正常索引与查询
  Steps:
    1. 运行 `pnpm build`
    2. 运行 `pnpm test`
    3. 运行一次 MCP smoke（复用已有 runtime/mcp 测试脚本）
    4. 断言退出码均为 0
  Expected Result: 构建和既有测试全部通过，无新增回归
  Failure Indicators: 任一命令非 0、测试快照逻辑变化
  Evidence: 终端输出日志

Scenario: source_code_only 过滤生效
  Tool: Bash
  Preconditions: 有包含 `.md` 与 `.ts` 的索引样本
  Steps:
    1. 调用 `handleCodebaseRetrieval`（测试内）设置 `source_code_only: true`
    2. 收集返回 seeds/segments 的 `filePath`
    3. 断言不含 `.md`/`.json`/`.yaml`/`.yml`/`.toml`/`.xml`
    4. 断言存在至少一个 code 类结果（例如 `.ts`）
  Expected Result: 文档与配置语言被过滤，代码语言保留
  Failure Indicators: 过滤后仍出现 docs/config，或错误清空结果
  Evidence: 测试断言输出

Scenario: 参数冲突与非法输入防护
  Tool: Bash
  Preconditions: MCP schema 校验逻辑已接入
  Steps:
    1. 输入 `source_code_only + include_languages`，断言报错
    2. 输入 include/exclude 交集，断言报错
    3. 输入未知语言值，断言报错
  Expected Result: 错误信息稳定且可定位
  Failure Indicators: 冲突组合被悄悄接受、SQL 层才报错
  Evidence: 测试断言输出

---

## Execution Strategy

### Parallel Execution Waves

Wave 1（可并行）:
- Task 1 语言分类能力
- Task 2 MCP 参数与校验
- Task 3 `BuildContextPackOptions` 透传字段扩展

Wave 2（依赖 Wave 1）:
- Task 4 SearchService 向量 pre-filter
- Task 5 FTS 双路径 pre-filter + `files(language)` 索引
- Task 6 后置兜底过滤与边界统一
- Task 7 测试与回归验证

Critical Path: Task 1 -> Task 2 -> Task 4 -> Task 5 -> Task 7

### Dependency Matrix

| Task | Depends On | Blocks | Can Parallelize With |
|------|------------|--------|----------------------|
| 1 | None | 2, 5, 7 | 2, 3 |
| 2 | 1 | 4, 7 | 3 |
| 3 | None | 4, 5 | 1, 2 |
| 4 | 2, 3 | 7 | 5, 6 |
| 5 | 1, 3 | 7 | 4, 6 |
| 6 | 4, 5 | 7 | 4, 5 |
| 7 | 1..6 | None | None |

---

## TODOs

- [x] 1. 实现语言分类常量与工具函数（language.ts）

  **What to do**:
  - 在 `src/scanner/language.ts` 新增 `LANGUAGE_CATEGORIES`（code/docs/config）。
  - 导出 `getCodeLanguages()` 与 `isKnownLanguage()`。
  - 保持 `LANGUAGE_MAP` 现有映射不变。

  **Must NOT do**:
  - 不调整历史扩展名到语言的映射关系。

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 单文件、规则清晰、低复杂度。
  - **Skills**: `test-driven-development`
    - `test-driven-development`: 确保分类表行为可验证。

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: 2, 5, 7
  - **Blocked By**: None

  **References**:
  - `src/scanner/language.ts:4` - 当前语言映射定义。
  - `src/scanner/language.ts:85` - 已有语言列表导出函数。

  **Acceptance Criteria**:
  - [ ] `getCodeLanguages()` 返回 code 类语言，不含 `markdown/json/yaml/toml/xml`。
  - [ ] `isKnownLanguage('typescript') === true`，`isKnownLanguage('unknown_x') === false`。

- [x] 2. MCP 参数扩展与冲突/白名单校验（codebaseRetrieval.ts）

  **What to do**:
  - 在 `codebaseRetrievalSchema` 增加 `source_code_only`、`include_languages`、`exclude_languages`。
  - 实现冲突规则：
    - `source_code_only + include_languages` 报错。
    - include/exclude 交集报错。
  - 语言值白名单校验：仅允许 `getAllowedLanguages()` + `unknown`。
  - 归一化出最终 `languageFilter`（允许 `source_code_only + exclude_languages` 叠加）。

  **Must NOT do**:
  - 不修改现有 `include_globs/exclude_globs` 语义。

  **Recommended Agent Profile**:
  - **Category**: `unspecified-low`
  - **Skills**: `systematic-debugging`, `test-driven-development`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: 4, 7
  - **Blocked By**: 1

  **References**:
  - `src/mcp/tools/codebaseRetrieval.ts:30` - Zod schema 入口。
  - `src/mcp/tools/codebaseRetrieval.ts:250` - 参数解构点。
  - `src/mcp/tools/codebaseRetrieval.ts:327` - 调用 `buildContextPack` 的 options 入口。
  - `src/search/pathFilter.ts:13` - 可复用的参数归一化风格。

  **Acceptance Criteria**:
  - [ ] 3 组冲突规则全部有明确错误。
  - [ ] 未知语言输入被 MCP 层拒绝。
  - [ ] 未传新参数时行为保持兼容。

- [x] 3. 扩展查询选项类型（search/types.ts）

  **What to do**:
  - 扩展 `BuildContextPackOptions`，新增 `languageFilter?: string[]`。
  - 保持 `filePathFilter` 兼容。

  **Must NOT do**:
  - 不改 `SearchConfig`。

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `test-driven-development`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: 4, 5
  - **Blocked By**: None

  **References**:
  - `src/search/types.ts:100` - 现有 options 定义。

  **Acceptance Criteria**:
  - [ ] 编译通过，调用链可接收 `languageFilter`。

- [ ] 4. 向量召回 pre-filter 接入（SearchService + Indexer 管道）

  **What to do**:
  - 在 `SearchService` 中接收 `options.languageFilter`。
  - 构造安全 WHERE 子句并透传到 `this.indexer.textSearch(query, limit, filter)`。
  - 确保无过滤参数时不传 filter（零回归）。

  **Must NOT do**:
  - 不直接拼接未经白名单校验的用户输入。

  **Recommended Agent Profile**:
  - **Category**: `unspecified-low`
  - **Skills**: `systematic-debugging`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2
  - **Blocks**: 7
  - **Blocked By**: 2, 3

  **References**:
  - `src/search/SearchService.ts:111` - `buildContextPack` 入口。
  - `src/search/SearchService.ts:218` - `vectorRetrieve` 入口。
  - `src/indexer/index.ts:455` - `textSearch(query, limit, filter?)`。
  - `src/vectorStore/index.ts:249` - `search(..., filter?)` + `.where(filter)`。

  **Acceptance Criteria**:
  - [ ] 指定语言过滤时，向量召回仅返回指定语言文件。
  - [ ] 无过滤时，向量召回行为与旧版一致。

- [ ] 5. FTS 双路径 pre-filter + files(language) 索引

  **What to do**:
  - 在 `searchChunksFts` 与 `searchFilesFts` 新增可选语言过滤参数。
  - 使用子查询：`... AND file_path/path IN (SELECT path FROM files WHERE language ... )`。
  - 为 `files(language)` 添加索引创建语句（`idx_files_language`）。
  - 确保 strict/relaxed 两种 FTS 查询策略都应用过滤。

  **Must NOT do**:
  - 不修改 `chunks_fts` / `files_fts` 表结构。
  - 不改 BM25 权重与分词策略。

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: `systematic-debugging`, `test-driven-development`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2
  - **Blocks**: 7
  - **Blocked By**: 1, 3

  **References**:
  - `src/search/fts.ts:325` - `searchChunksFts`。
  - `src/search/fts.ts:626` - `searchFilesFts`。
  - `src/search/SearchService.ts:244` - 词法召回分发入口。
  - `src/search/SearchService.ts:264` - chunk FTS 路径。
  - `src/search/SearchService.ts:328` - file FTS fallback 路径。
  - `src/db/index.ts:92` - `files` 表含 `language` 列。

  **Acceptance Criteria**:
  - [ ] chunks_fts 路径过滤生效。
  - [ ] files_fts fallback 路径过滤生效。
  - [ ] `idx_files_language` 被创建，查询可使用索引。

- [ ] 6. 扩展阶段兜底语言过滤（防止跨阶段漏网）

  **What to do**:
  - 在 `SearchService` 的 expand 后（与现有 pathFilter 同层）增加语言兜底过滤。
  - 保证 seeds 与 expanded 结果语言口径一致。

  **Must NOT do**:
  - 不改变 graph expansion 算法本身（E1/E2/E3 权重与策略）。

  **Recommended Agent Profile**:
  - **Category**: `unspecified-low`
  - **Skills**: `systematic-debugging`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2
  - **Blocks**: 7
  - **Blocked By**: 4, 5

  **References**:
  - `src/search/SearchService.ts:160` - expand 后处理位置。
  - `src/search/SearchService.ts:162` - 现有 path filter 后处理样式。
  - `src/search/GraphExpander.ts:86` - expand 主流程。

  **Acceptance Criteria**:
  - [ ] expanded 结果中不存在未授权语言。

- [ ] 7. 单元测试与回归验证

  **What to do**:
  - 增加 language 分类测试、参数校验测试、向量/FTS pre-filter 测试、无参数回归测试。
  - 优先对齐现有 runtime 测试组织方式。
  - 运行全量 `pnpm build && pnpm test`。

  **Must NOT do**:
  - 不引入新的测试框架。

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: `test-driven-development`, `verification-before-completion`

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Sequential（收口任务）
  - **Blocks**: None
  - **Blocked By**: 1..6

  **References**:
  - `tests/runtime/chunks-fts-search.test.ts` - FTS 测试风格参考。
  - `package.json` - 测试脚本与执行入口。

  **Acceptance Criteria**:
  - [ ] 新增测试覆盖冲突校验、分类正确性、双路径 pre-filter。
  - [ ] `pnpm build` 与 `pnpm test` 全通过。
  - [ ] 无参数路径回归通过。

---

## Commit Strategy

| After Task | Message | Files | Verification |
|------------|---------|-------|--------------|
| 1-3 | `feat(search): add language filter contract and schema` | `src/scanner/language.ts`, `src/mcp/tools/codebaseRetrieval.ts`, `src/search/types.ts` | `pnpm build` |
| 4-6 | `feat(search): apply language pre-filter in retrieval pipeline` | `src/search/SearchService.ts`, `src/search/fts.ts`, `src/db/index.ts` | `pnpm build && pnpm test` |
| 7 | `test(search): cover language filtering and conflict validation` | `tests/runtime/*` | `pnpm test` |

---

## Success Criteria

### Verification Commands

```bash
pnpm build
pnpm test
```

### Final Checklist
- [ ] MCP 支持 3 个新参数，且冲突规则完全生效
- [ ] 向量与 FTS 都是 pre-filter，不是仅 post-filter
- [ ] chunks_fts 与 files_fts fallback 都覆盖
- [ ] 默认行为向后兼容（无参数等价）
- [ ] SQL 输入经过白名单收敛，无注入风险
- [ ] 构建与测试全绿
