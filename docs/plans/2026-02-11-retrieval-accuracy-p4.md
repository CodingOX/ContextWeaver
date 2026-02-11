# Retrieval Accuracy P4 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在不引入外部依赖的前提下，完成 P4 两项能力：离线自动调参与线上隐式反馈闭环最小实现。

**Architecture:** P4-1 采用“回放式调参”路径，基于向量/词法召回列表重放 RRF 融合并自动搜索最优参数；P4-2 在 `codebase-retrieval` 过程中持久化检索事件，通过相邻请求推断隐式使用信号并提供 CLI 汇总。两条能力共享 `index.db`，避免新增存储系统。

**Tech Stack:** TypeScript、Node.js、better-sqlite3、现有 `search/eval` 指标模块（Recall@K/MRR/nDCG）

---

### Task 1: P4-1 测试先行（自动调参）

**Files:**
- Create: `tests/benchmark/auto-tune.test.ts`
- Create: `tests/benchmark/fixtures/sample-auto-tune-dataset.jsonl`

**Step 1: 写失败测试（解析 + 融合 + 选优）**
- 断言数据集可解析为 replay case。
- 断言 `wVec/wLex/rrfK0` 变化可改变指标。
- 断言可根据 target 指标选出最佳参数。

**Step 2: 运行测试确认失败**
- Run: `pnpm -s tsx tests/benchmark/auto-tune.test.ts`
- Expected: 失败（模块不存在或函数未实现）。

### Task 2: P4-1 最小实现（回放调参）

**Files:**
- Create: `src/search/eval/autoTune.ts`
- Create: `src/search/eval/autoTuneDataset.ts`
- Modify: `src/search/eval/types.ts`
- Modify: `src/index.ts`
- Modify: `package.json`
- Modify: `README.md`

**Step 1: 实现数据模型与数据集加载**
- 新增 replay case 类型：`vectorRetrieved`、`lexicalRetrieved`、`relevant`。
- 支持 JSON/JSONL 加载与字段校验。

**Step 2: 实现调参引擎**
- 实现 RRF 回放融合（复用同公式）。
- 实现参数网格展开与约束（`wLex = 1 - wVec`）。
- 复用指标函数，输出 best config + topN leaderboard。

**Step 3: 提供 CLI 命令**
- 新增 `contextweaver tune <dataset>`。
- 支持 `--target`、`--k`、`--top`。

### Task 3: P4-2 测试先行（隐式反馈闭环）

**Files:**
- Create: `tests/runtime/feedback-loop.test.ts`

**Step 1: 写失败测试（信号推断 + 汇总）**
- 断言相邻请求中的 path pin 可产生正反馈。
- 断言无命中后重写请求可产生负反馈。
- 断言可产出 summary 与 top files。

**Step 2: 运行测试确认失败**
- Run: `pnpm -s tsx tests/runtime/feedback-loop.test.ts`
- Expected: 失败（模块不存在或函数未实现）。

### Task 4: P4-2 最小实现（采集 + 聚合）

**Files:**
- Create: `src/search/feedbackLoop.ts`
- Modify: `src/db/index.ts`
- Modify: `src/mcp/tools/codebaseRetrieval.ts`
- Modify: `src/index.ts`
- Modify: `README.md`

**Step 1: 新增 feedback 表结构与读写函数**
- 新建 `retrieval_events` / `retrieval_event_chunks` / `retrieval_signals`。
- 提供记录检索事件与信号聚合查询。

**Step 2: 在 MCP 检索链路接入采集**
- 在 `handleCodebaseRetrieval` 结束时记录 event + seeds。
- 与上一次 event 比较，推断 S1/S2/S3（最小信号集）。

**Step 3: 新增 CLI 汇总命令**
- `contextweaver feedback [path] --days 7 --top 10`
- 输出：total events、zero-hit rate、implicit success rate、top reused files。

### Task 5: 验证与收尾

**Files:**
- Modify: `docs/todo.md`

**Step 1: 运行专项测试**
- `pnpm -s tsx tests/benchmark/auto-tune.test.ts`
- `pnpm -s tsx tests/runtime/feedback-loop.test.ts`

**Step 2: 运行全量与构建**
- `pnpm test`
- `pnpm run test:benchmark`
- `pnpm build`

**Step 3: 更新 todo 状态**
- 勾选 P4 两项，记录最新完成项。
