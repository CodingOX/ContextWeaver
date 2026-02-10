# Embedding 413 自动拆分重试变更日志（2026-02-10）

## 变更目标

当 Embedding API 返回 `HTTP 413`（请求体过大）时，避免整批任务直接失败，改为自动拆分批次重试，降低一次失败导致本轮文件全部重建的概率。

## 改动摘要

### 1) `EmbeddingClient` 增加 413 识别与拆分重试

- 文件：`src/api/embedding.ts`
- 关键变更：
  - 在 `processWithRateLimit` 中增加 `isPayloadTooLarge` 分支。
  - 当 `413` 且当前批次长度 `> 1` 时：
    - 释放当前并发槽位；
    - 按二分法拆成左右两个子批次；
    - 递归调用 `processWithRateLimit` 分别处理；
    - 合并并返回结果，保留原索引顺序。

### 2) 进度统计支持动态批次数

- 文件：`src/api/embedding.ts`
- 关键变更：
  - `ProgressTracker` 新增 `expandTotal(extraBatches)`。
  - 在 413 拆分时将总批次数 `+1`，保证日志与进度百分比正确。

### 3) 新增回归测试（TDD）

- 文件：`tests/runtime/embedding-client.test.ts`
- 覆盖场景：
  1. 批次触发 413 后自动拆分并最终成功。
  2. 单条文本触发 413 时直接失败（不做无意义拆分）。
  3. 非 413 错误保持原行为直接抛出。

### 4) 测试脚本接入

- 文件：`package.json`
- 关键变更：
  - 将 `tests/runtime/embedding-client.test.ts` 加入 `pnpm test` 主脚本。

## 验证记录（本地）

执行时间：2026-02-10

1. `pnpm -s tsx tests/runtime/embedding-client.test.ts`
   - 结果：通过（3/3）
   - 退出码：`0`

2. `pnpm build`
   - 结果：通过
   - 退出码：`0`

3. `pnpm test`
   - 结果：失败（与本次改动无关）
   - 失败点：`tests/runtime/docs-guard.test.ts`
   - 断言信息：README 文案未命中 `/可选语言插件/`
   - 退出码：`1`

## 结论

本次改动已实现 `413` 自动拆分重试，并通过新增回归测试与构建验证。当前全量测试失败来源于既有 README 文案守卫，与本次 Embedding 逻辑改动无直接耦合。
