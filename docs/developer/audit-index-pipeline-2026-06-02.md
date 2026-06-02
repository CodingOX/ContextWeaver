# 代码审计报告：CodeRecall 索引管线

## 1. 元信息

- **项目/模块**：CodeRecall 索引管线（API Client / Indexer / VectorStore / Scanner）
- **审计日期**：2026-06-02
- **审计范围**：`src/api/`, `src/indexer/`, `src/vectorStore/`, `src/scanner/`, `src/db/`, `src/utils/`, `src/mcp/`, `src/search/SearchService.ts`
- **审计语言/技术栈**：TypeScript / Node.js 22 / LanceDB / better-sqlite3
- **审计文件数**：14

## 2. 执行摘要

索引管线整体架构清晰，自愈机制和批量优化设计合理。但在**断点续传**和**Key 热替换**两个场景存在明显缺陷：Embedding 失败时全量回滚丢失已完成进度，API Client 单例缓存导致更换 Key 后无法生效。此外，VectorStore.close() 未真正释放 native 连接，MCP 长驻进程存在资源泄漏风险。

| 指标 | 数值 |
|------|------|
| 总发现数 | 10 |
| P0 (阻塞) | 1 |
| P1 (严重) | 3 |
| P2 (一般) | 4 |
| P3 (建议) | 2 |
| 审计维度覆盖 | 内存泄漏 / 性能 / 可靠性 / 断点续传 |

## 3. 严重级别定义

| 级别 | 标签 | 定义 | 响应时限 |
|------|------|------|----------|
| P0 | 🔴 阻塞 | 生产隐患、数据丢失风险 | 立即修复 |
| P1 | 🟠 严重 | 明显 bug、性能瓶颈、架构问题 | 1-3 天 |
| P2 | 🟡 一般 | 代码异味、可维护性问题 | 1-2 周 |
| P3 | 🔵 建议 | 风格优化、非强制改进 | 酌情处理 |

## 4. 详细发现列表

| ID | 文件位置 | 行号 | 严重级 | 维度 | 描述 |
|----|----------|------|--------|------|------|
| #1 | src/indexer/index.ts | 306-318 | P0 | 可靠性/断点续传 | Embedding 失败全量回滚，已完成的批次进度全部丢失 |
| #2 | src/api/embedding.ts | 675-682 | P1 | 可靠性/Key热替换 | EmbeddingClient 单例缓存，更换 Key 后不生效 |
| #3 | src/vectorStore/index.ts | 362-365 | P1 | 内存泄漏 | close() 只置空引用，未关闭 LanceDB native 连接 |
| #4 | src/api/embedding.ts | 361-365 | P1 | 可靠性 | API Key 轮询无坏 Key 跳过机制 |
| #5 | src/indexer/index.ts | 285-318 | P2 | 性能/内存 | batchIndex 全量 texts + embeddings 同时驻留内存 |
| #6 | src/utils/logger.ts | 85 | P2 | 内存泄漏 | WriteStream 从未显式关闭 |
| #7 | src/search/SearchService.ts | 92 | P2 | 内存泄漏 | tokenBoundaryRegexCache 无上限增长 |
| #8 | src/vectorStore/index.ts | 216-223 | P2 | 性能 | 批量 DELETE OR 条件字符串可能过长 |
| #9 | src/api/embedding.ts | 509-521 | P3 | 可靠性 | 413 递归拆分潜在栈深度 |
| #10 | src/api/embedding.ts | 316-326 | P3 | 可靠性 | RateLimitController 全局单例状态跨 run 残留 |

---

## 5. 发现详情

### [#1] Embedding 失败全量回滚 — 无法断点续传

- **位置**：`src/indexer/index.ts:306-318`
- **严重级别**：P0
- **维度**：可靠性 / 断点续传

**问题描述**：
`batchIndex` 将所有文件的 texts 合并为一次 `embedBatch` 调用。如果中间某个批次失败（如 401 Key 过期），catch 块调用 `clearVectorIndexHash` 清除**所有**文件的 hash 标记，包括已经成功返回 embedding 的批次。

```typescript
// 当前代码：失败时一刀切
catch (err) {
  clearVectorIndexHash(db, files.map((f) => f.path)); // 所有文件全部回滚
  return { success: 0, errors: files.length };
}
```

**影响评估**：
- 大型代码库（数千文件）索引到 90% 时遇到 Key 过期，更换 Key 后必须**从零重跑全部 embedding**
- 浪费大量 API 调用费用和时间
- **用户核心场景"换 Key 后接上任务"无法实现**

**建议修复方案**：
将 `embedBatch` 改为按文件粒度分批，每完成一批文件就立即写入 LanceDB 并更新 `vector_index_hash`。失败时只回滚未完成的部分：

```typescript
// 方案：按文件组分批 embedding，逐批落盘
const BATCH_SIZE = 50; // 每批 50 个文件
for (let i = 0; i < files.length; i += BATCH_SIZE) {
  const batch = files.slice(i, i + BATCH_SIZE);
  const texts = batch.flatMap(f => f.chunks.map(c => c.vectorText));
  
  try {
    const results = await embeddingClient.embedBatch(texts, 20);
    // 立即写入 LanceDB + 更新 hash
    await this.vectorStore.batchUpsertFiles(...);
    batchUpdateVectorIndexHash(db, batch.map(f => ({ path: f.path, hash: f.hash })));
  } catch (err) {
    // 只标记当前批次失败，已完成的批次不受影响
    clearVectorIndexHash(db, batch.map(f => f.path));
    errors += batch.length;
  }
}
```

---

### [#2] EmbeddingClient/RerankerClient 单例缓存 — 更换 Key 不生效

- **位置**：`src/api/embedding.ts:675-682`, `src/api/reranker.ts:238-249`
- **严重级别**：P1
- **维度**：可靠性 / Key 热替换

**问题描述**：
`getEmbeddingClient()` 和 `getRerankerClient()` 使用模块级单例，构造时从 `getEmbeddingConfig()` 读取 Key 列表并缓存。用户修改 `.env` 中的 Key 后，旧单例仍持有旧 Key 列表。

```typescript
let defaultClient: EmbeddingClient | null = null;
export function getEmbeddingClient(): EmbeddingClient {
  if (!defaultClient) {
    defaultClient = new EmbeddingClient(); // 只在首次调用时创建
  }
  return defaultClient;
}
```

**影响评估**：
- MCP 长驻进程中，用户更换 Key 后必须重启进程才能生效
- 与 #1 叠加：即使 #1 修复了断点续传，如果 Key 没换成功，续传仍会用旧 Key 失败

**建议修复方案**：
添加 `resetClient()` 方法，或在 `getEmbeddingConfig()` 检测到 Key 变化时重建实例：

```typescript
export function resetEmbeddingClient(): void {
  defaultClient = null;
}
```

在 `scan()` 的入口处调用 `resetEmbeddingClient()` 确保每次 scan 使用最新配置。

---

### [#3] VectorStore.close() 未真正关闭 LanceDB 连接

- **位置**：`src/vectorStore/index.ts:362-365`
- **严重级别**：P1
- **维度**：内存泄漏

**问题描述**：
`close()` 方法只将 `this.db` 和 `this.table` 置为 `null`，但未调用 LanceDB 的任何 close/disconnect API。native 模块持有的文件句柄和内存映射可能不会被 GC 及时回收。

```typescript
async close(): Promise<void> {
  this.db = null;    // 只置空引用
  this.table = null; // native 资源未释放
}
```

**影响评估**：
- MCP 长驻进程中，每次 `SearchService.close()` 调用 `closeVectorStore()`，但 native 资源未真正释放
- 长时间运行后可能累积大量未关闭的 LanceDB 连接

**建议修复方案**：
检查 LanceDB SDK 是否提供 `close()` 或 `disconnect()` 方法，在 `close()` 中显式调用。

---

### [#4] API Key 轮询无坏 Key 跳过机制

- **位置**：`src/api/embedding.ts:361-365`
- **严重级别**：P1
- **维度**：可靠性

**问题描述**：
`getNextApiKey()` 使用简单 round-robin 轮询。如果池中某个 Key 已失效（过期/被禁），每 N 次请求就会用这个 Key 失败一次，然后触发重试。没有机制将坏 Key 临时或永久移出轮询池。

```typescript
private getNextApiKey(): string {
  const key = this.apiKeyPool[this.nextApiKeyIndex];
  this.nextApiKeyIndex = (this.nextApiKeyIndex + 1) % this.apiKeyPool.length;
  return key; // 坏 Key 依然会被周期性使用
}
```

**影响评估**：
- 3 个 Key 中有 1 个过期时，33% 的请求会先失败再重试，降低吞吐量
- 429 限速场景下，坏 Key 会加剧退避等待

**建议修复方案**：
引入 Key 健康度追踪，连续失败的 Key 临时降级（冷却期后再试）：

```typescript
private keyFailures = new Map<number, number>();
private getNextApiKey(): string {
  for (let i = 0; i < this.apiKeyPool.length; i++) {
    const idx = (this.nextApiKeyIndex + i) % this.apiKeyPool.length;
    if ((this.keyFailures.get(idx) ?? 0) < 3) {
      this.nextApiKeyIndex = idx + 1;
      return this.apiKeyPool[idx];
    }
  }
  // 所有 Key 都有失败记录，重置并重试
  this.keyFailures.clear();
  return this.apiKeyPool[this.nextApiKeyIndex++ % this.apiKeyPool.length];
}
```

---

### [#5] batchIndex 内存峰值：全量 texts + embeddings 同时驻留

- **位置**：`src/indexer/index.ts:285-318`
- **严重级别**：P2
- **维度**：性能 / 内存

**问题描述**：
`batchIndex` 先收集所有文件的所有 chunk text 到 `allTexts` 数组，然后一次性调用 `embedBatch`，返回的 `embeddings` 数组与 `allTexts` 同时驻留内存。对于大型代码库（10000+ chunks，每个 chunk ~500 tokens），峰值内存可达数百 MB。

**影响评估**：
- 大型项目索引时可能出现内存压力
- 与 #1 修复方案天然耦合：改为分批处理后内存峰值自然降低

**建议修复方案**：
与 #1 的按文件组分批方案合并解决，每批处理完后释放该批的 texts 和 embeddings。

---

### [#6] Logger WriteStream 未关闭

- **位置**：`src/utils/logger.ts:85`
- **严重级别**：P2
- **维度**：内存泄漏

**问题描述**：
`createFormattedStream` 创建的 `fs.createWriteStream` 在整个进程生命周期内保持打开。对于 CLI 短生命周期进程影响不大，但 MCP 长驻进程中，日志文件句柄始终持有。

**影响评估**：
- 低风险，但不够规范
- 跨日运行时，旧日志文件句柄可能未释放（`getLogFileName` 按日切换但旧 stream 未 close）

**建议修复方案**：
在进程退出信号（SIGTERM/SIGINT）时显式关闭 logger stream，或在日期切换时关闭旧 stream。

---

### [#7] tokenBoundaryRegexCache 无上限增长

- **位置**：`src/search/SearchService.ts:92`
- **严重级别**：P2
- **维度**：内存泄漏

**问题描述**：
`tokenBoundaryRegexCache` 是模块级 Map，每次搜索的新 token 都会缓存一个 RegExp。MCP 长驻进程中，随着查询累积，缓存无限增长。

**影响评估**：
- 每个 RegExp 对象占用较小，短期影响不大
- 长期运行（数万次查询后）可能累积数千条目

**建议修复方案**：
使用 LRU 缓存（如 `lru-cache`）或限制最大条目数（如 1000），超出后淘汰最旧条目。

---

### [#8] 批量 DELETE OR 条件字符串可能过长

- **位置**：`src/vectorStore/index.ts:216-223`
- **严重级别**：P2
- **维度**：性能

**问题描述**：
`batchUpsertFiles` 中，每批最多 50 个文件的删除条件拼接为一条 OR SQL。如果文件路径较长（如 Java 项目的深层包路径），拼接出的 SQL 字符串可能达到数 KB，影响 LanceDB SQL 解析性能。

**建议修复方案**：
如果 LanceDB 支持参数化查询或 IN 子句，改用更高效的条件表达方式。或减小 `BATCH_FILES` 参数。

---

### [#9] 413 递归拆分潜在栈深度

- **位置**：`src/api/embedding.ts:509-521`
- **严重级别**：P3
- **维度**：可靠性

**问题描述**：
`processWithRateLimit` 在 413 错误时递归调用自身拆分批次。虽然 `texts.length > 1` 守卫避免了无限递归，但极端情况下（持续 413）递归深度为 log2(batchSize)，约 4-5 层，风险较低。

---

### [#10] RateLimitController 全局单例状态跨 run 残留

- **位置**：`src/api/embedding.ts:316-326`
- **严重级别**：P3
- **维度**：可靠性

**问题描述**：
`globalRateLimitController` 是模块级单例，`backoffMs` 和 `currentConcurrency` 状态在多次 scan 之间持久化。上一次 scan 结尾的高退避值可能影响下一次 scan 的初始并发。

---

## 6. 统计汇总

### 按严重级别分布

| 级别 | 数量 | 占比 |
|------|------|------|
| P0 | 1 | 10% |
| P1 | 3 | 30% |
| P2 | 4 | 40% |
| P3 | 2 | 20% |

### 按维度分布

| 维度 | 数量 | 占比 |
|------|------|------|
| 可靠性/断点续传 | 3 | 30% |
| 内存泄漏 | 3 | 30% |
| 性能 | 2 | 20% |
| Key 热替换 | 1 | 10% |
| 其他 | 1 | 10% |

## 7. 改进建议

### 短期（1 周内）
1. **修复 #1**：将 `batchIndex` 改为按文件组分批 embedding + 逐批落盘，实现真正的断点续传
2. **修复 #2**：在 `scan()` 入口重置 EmbeddingClient/RerankerClient 单例，确保 Key 变更生效
3. **修复 #3**：在 `VectorStore.close()` 中调用 LanceDB 的 close API

### 中期（1-4 周）
4. **修复 #4**：引入 Key 健康度追踪，坏 Key 自动降级
5. **修复 #5**：随 #1 一并解决内存峰值问题
6. **修复 #7**：将 regexCache 改为 LRU 缓存

### 长期（1-3 月）
7. 考虑引入 embedding 结果持久化缓存（磁盘），避免相同 chunk 重复调用 API
8. 为 MCP 长驻进程添加定期资源清理机制

## 8. 核心结论

**关于"换 Key 后能否接上任务"**：当前**不能**。原因有两层：
1. `EmbeddingClient` 单例缓存了旧 Key 列表（#2），换 Key 后不生效
2. 即使 Key 生效，Embedding 失败时全量回滚（#1），已完成进度全部丢失

修复优先级：**#2 → #1**，先确保 Key 能热替换，再实现断点续传。
