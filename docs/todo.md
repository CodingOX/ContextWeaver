# 检索准确性优化 TODO（2026-02-11）

> 范围：ContextWeaver 检索链路（召回、融合、Rerank、索引与评测）

## P0（立即执行）

- [x] Rerank 失败自动降级到 RRF 结果，避免 `buildContextPack` 整体失败
  - 目标文件：`src/search/SearchService.ts`
  - 测试文件：`tests/runtime/search-rerank-fallback.test.ts`
  - 验收标准：Rerank 抛错时仍返回可用 seeds/files，并记录告警日志

- [x] 修复 `chunks_fts` 的 breadcrumb 双重计分偏差
  - 目标文件：`src/indexer/index.ts`
  - 测试文件：`tests/runtime/chunk-fts-content.test.ts`
  - 验收标准：FTS `content` 不再重复拼接 breadcrumb，排序回归测试通过

## P1（高 ROI）

- [x] 查询分通道：向量 / 词法 / Rerank 使用不同 query
  - 目标文件：`src/mcp/tools/codebaseRetrieval.ts`、`src/search/SearchService.ts`、`src/search/types.ts`
  - 测试文件：`tests/runtime/query-channel-build.test.ts`、`tests/runtime/search-query-routing.test.ts`
  - 验收标准：
    - 向量通道只使用 `information_request`
    - 词法通道优先 `technical_terms`，`information_request` 作为补充
    - Rerank 使用完整 query

- [x] 在融合后、Rerank 前增加 `per-file cap`（默认 5）
  - 目标文件：`src/search/SearchService.ts`、`src/search/config.ts`、`src/search/types.ts`
  - 测试文件：`tests/runtime/per-file-cap.test.ts`
  - 验收标准：候选池单文件上限生效，且整体 seeds 数量满足最小可用阈值

## P2（覆盖率与评测）

- [x] 精准扩覆盖（避免“全量文本兜底”引入噪声）
  - 目标文件：`src/scanner/processor.ts`、`src/scanner/filter.ts`
  - 策略：
    - 已知代码扩展名的大文件阈值提升到 500KB，并启用降级行分片
    - 未知扩展名默认继续跳过，支持显式 include
    - `FALLBACK_LANGS` 与语言白名单保持一致

- [x] 建立离线评测基线（Recall@K / MRR / nDCG）
  - 目标目录：`tests/benchmark/`（新增）
  - 产物：基准查询集、评测脚本、基线报告

## P3（精细化）

- [ ] FTS 分字段建模与 BM25 权重策略（`symbol_tokens/breadcrumb/body/comments`）
- [ ] 索引一致性审计与自愈（离线比对 `VectorStore` 与 `chunks_fts` 的 `chunk_id` 集合）

## P4（长期）

- [ ] 自动调参（基于离线评测集）
- [ ] 线上隐式反馈闭环（结果是否被后续工具调用实际使用）

## 备注

- 当前路线优先“先修确定性问题（健壮性/明确 bug）”，再做召回策略增强。
- 禁止将“所有可读文本默认兜底分片”作为短期策略，避免召回噪声失控。

- 最近完成：P0/P1 四项（Rerank 降级、FTS 去重计分、查询分通道、per-file cap）。
- 最近完成：P2 两项（精准扩覆盖策略、离线 benchmark 基线）。
