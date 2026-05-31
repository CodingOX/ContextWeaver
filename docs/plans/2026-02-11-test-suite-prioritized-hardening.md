# Test Suite Prioritized Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将当前“部分单元测试被遗漏”的状态升级为“可验证的全量单元测试基线”，并优先补齐锁机制和索引自愈相关回归测试。

**Architecture:** 先做测试入口治理（脚本与守卫），确保新增测试不会再次被漏跑；再补高风险链路（锁机制 + 自愈收敛）回归测试；最后补核心检索模块（ContextPacker / GraphExpander）的行为测试。所有改动遵循 @test-driven-development：先红后绿，每个任务独立提交。

**Tech Stack:** TypeScript、Node.js test runner（`node:test` via `tsx`）、pnpm、better-sqlite3、现有 Search/Scanner 模块

---

### Task 1 (P0): 测试入口补齐与防回退守卫

**Files:**
- Create: `tests/runtime/test-script-completeness.test.ts`
- Modify: `package.json`
- Test: `tests/runtime/test-script-completeness.test.ts`

**Step 1: Write the failing test**

```ts
// tests/runtime/test-script-completeness.test.ts
// 目标：断言 package.json 的 test 脚本覆盖 tests/runtime 下全部 *.test.ts
// 规则：排除 benchmark/e2e/install，只校验 runtime + language-support
```

**Step 2: Run test to verify it fails**

Run: `pnpm -s tsx tests/runtime/test-script-completeness.test.ts`
Expected: FAIL，提示 `pnpm test` 缺少以下测试：
- `tests/runtime/fallback-split.test.ts`
- `tests/runtime/parser-pool.test.ts`
- `tests/runtime/lang-ts21-plugin.test.ts`
- `tests/runtime/lang-ts22-plugin.test.ts`

**Step 3: Write minimal implementation**

```json
// package.json
{
  "scripts": {
    "test": "... && tsx tests/runtime/fallback-split.test.ts && tsx tests/runtime/parser-pool.test.ts && tsx tests/runtime/lang-ts21-plugin.test.ts && tsx tests/runtime/lang-ts22-plugin.test.ts",
    "test:unit:all": "pnpm test && pnpm run test:benchmark"
  }
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm -s tsx tests/runtime/test-script-completeness.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add package.json tests/runtime/test-script-completeness.test.ts
git commit -m "test: enforce runtime test script completeness"
```

---

### Task 2 (P0): 锁机制回归测试（针对 bb08898）

**Files:**
- Create: `tests/runtime/lock-regression.test.ts`
- Test: `tests/runtime/lock-regression.test.ts`
- (Optional Modify if needed): `src/utils/lock.ts`

**Step 1: Write the failing test**

```ts
// 场景 A：死进程锁文件存在时，withLock 应自动清理并成功获取锁
// 场景 B：同 projectId 并发获取锁，第二个调用在短超时下应失败
// 场景 C：第一个释放后，后续调用应恢复成功
```

**Step 2: Run test to verify it fails**

Run: `pnpm -s tsx tests/runtime/lock-regression.test.ts`
Expected: FAIL（初始阶段可能出现锁清理、并发等待或错误信息断言不满足）

**Step 3: Write minimal implementation**

```ts
// src/utils/lock.ts（仅在测试失败时最小修复）
// 仅允许修复测试暴露的问题：
// - 失效锁清理竞态
// - EPERM 进程探测处理
// - 超时错误稳定性
```

**Step 4: Run test to verify it passes**

Run: `pnpm -s tsx tests/runtime/lock-regression.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/runtime/lock-regression.test.ts src/utils/lock.ts
git commit -m "test(lock): add regression coverage for stale and concurrent locks"
```

---

### Task 3 (P1): 索引自愈“收敛”回归测试

**Files:**
- Create: `tests/runtime/index-healing-convergence.test.ts`
- Test: `tests/runtime/index-healing-convergence.test.ts`
- (Optional Modify if needed): `src/indexer/index.ts`, `src/scanner/index.ts`

**Step 1: Write the failing test**

```ts
// 目标：modified 文件在“无 chunks”情况下不应无限进入自愈循环
// 断言：执行一次索引后，该文件不再出现在 getFilesNeedingVectorIndex() 结果中
```

**Step 2: Run test to verify it fails**

Run: `pnpm -s tsx tests/runtime/index-healing-convergence.test.ts`
Expected: FAIL（若收敛标记缺失，会重复命中 healing）

**Step 3: Write minimal implementation**

```ts
// src/indexer/index.ts
// 对 modified + chunks.length===0 的文件：
// - 清理旧向量（如存在）
// - 将 vector_index_hash 标记为当前 hash（视为已收敛）
```

**Step 4: Run test to verify it passes**

Run: `pnpm -s tsx tests/runtime/index-healing-convergence.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/runtime/index-healing-convergence.test.ts src/indexer/index.ts src/scanner/index.ts
git commit -m "test(indexer): prevent infinite healing by asserting convergence"
```

---

### Task 4 (P1): ContextPacker 行为测试（预算与区间合并）

**Files:**
- Create: `tests/runtime/context-packer.test.ts`
- Test: `tests/runtime/context-packer.test.ts`
- (Optional Modify if needed): `src/search/ContextPacker.ts`

**Step 1: Write the failing test**

```ts
// 场景 A：同文件重叠区间应合并为单段
// 场景 B：maxSegmentsPerFile 生效
// 场景 C：maxTotalChars 生效并截断后续文件
```

**Step 2: Run test to verify it fails**

Run: `pnpm -s tsx tests/runtime/context-packer.test.ts`
Expected: FAIL（若预算/合并边界存在偏差）

**Step 3: Write minimal implementation**

```ts
// src/search/ContextPacker.ts
// 仅修复测试失败项：
// - 区间合并边界
// - 文件排序与预算扣减顺序
```

**Step 4: Run test to verify it passes**

Run: `pnpm -s tsx tests/runtime/context-packer.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/runtime/context-packer.test.ts src/search/ContextPacker.ts
git commit -m "test(search): cover context packer merge and budget behavior"
```

---

### Task 5 (P2): GraphExpander 基本扩展策略测试

**Files:**
- Create: `tests/runtime/graph-expander.test.ts`
- Test: `tests/runtime/graph-expander.test.ts`
- (Optional Modify if needed): `src/search/GraphExpander.ts`

**Step 1: Write the failing test**

```ts
// 场景 A：neighborHops=0 时不产生邻居扩展
// 场景 B：breadcrumbExpandLimit=0 时不产生 breadcrumb 扩展
// 场景 C：importFilesPerSeed=0 时不触发跨文件扩展
```

**Step 2: Run test to verify it fails**

Run: `pnpm -s tsx tests/runtime/graph-expander.test.ts`
Expected: FAIL（若配置开关未被严格遵循）

**Step 3: Write minimal implementation**

```ts
// src/search/GraphExpander.ts
// 修复配置守卫与扩展开关判断，仅改失败断言涉及逻辑
```

**Step 4: Run test to verify it passes**

Run: `pnpm -s tsx tests/runtime/graph-expander.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/runtime/graph-expander.test.ts src/search/GraphExpander.ts
git commit -m "test(search): add graph expander strategy guard coverage"
```

---

### Task 6 (P2): 汇总脚本、文档与全量验收

**Files:**
- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/todo.md`

**Step 1: Write the failing test**

```ts
// 若已创建 tests/runtime/test-script-completeness.test.ts：
// 增加对 test:unit:all 的存在性断言（可作为 FAIL 起点）
```

**Step 2: Run test to verify it fails**

Run: `pnpm -s tsx tests/runtime/test-script-completeness.test.ts`
Expected: FAIL（若 test:unit:all 未定义或命令不正确）

**Step 3: Write minimal implementation**

```json
// package.json
{
  "scripts": {
    "test:unit:all": "pnpm test && pnpm run test:benchmark"
  }
}
```

**Step 4: Run test to verify it passes**

Run:
- `pnpm -s tsx tests/runtime/test-script-completeness.test.ts`
- `pnpm run test:unit:all`
- `pnpm build`

Expected: 全部 PASS

**Step 5: Commit**

```bash
git add package.json README.md docs/todo.md
git commit -m "docs(test): document full unit test entry and coverage hardening"
```

---

## 执行顺序（必须按优先级）

1. Task 1 (P0)
2. Task 2 (P0)
3. Task 3 (P1)
4. Task 4 (P1)
5. Task 5 (P2)
6. Task 6 (P2)

## 每轮验证清单（执行每个 Task 后）

```bash
pnpm -s tsx <当前新增测试文件>
pnpm test
```

## 最终验收清单

```bash
pnpm test
pnpm run test:benchmark
pnpm run test:unit:all
pnpm build
```
