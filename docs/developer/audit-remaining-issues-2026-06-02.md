# 审计报告遗留问题跟踪 — CodeRecall 索引管线

> 原始报告：`docs/developer/audit-index-pipeline-2026-06-02.md`
> 首轮修复：`docs/superpowers/plans/2026-06-02-batch-index-resilience.md`
> 修复提交：`485293e`
> 本文档生成日期：2026-06-02

---

## 概览

原始审计发现 10 项问题，首轮修复解决了 4 项（#1, #4, #5, #8 部分）。

| 状态 | 数量 | 占比 |
|------|------|------|
| 已修复 | 4 | 40% |
| 部分缓解 | 2 | 20% |
| 未处理 | 4 | 40% |

---

## 已修复

| 原 ID | 严重 | 问题 | 修复方式 |
|-------|------|------|---------|
| #1 | P0 | Embedding 失败全量回滚 | `batchIndex` 改为按 BATCH_CHUNKS=400 分批循环，每批独立 收集→Embedding→写库→标记 hash。失败批次只回滚当前批，`continue` 到下一批 |
| #4 | P1 | Key 轮询无坏 Key 跳过 | `getNextApiKey` → `getNextKeyIndex()`，引入 `badKeys: Map<index, banUntil>`（5 分钟 TTL），`processWithRateLimit` 识别 401/403 后自动 `markKeyBad()` + 切下一个 Key |
| #5 | P2 | 全量 texts+embeddings 内存峰值 | 随 #1 一并解决：`splitIntoChunkBatches()` 按 chunk 数动态分组，单批最多 400 chunks |
| #8 | P2 | 批量 DELETE OR 条件过长 | 部分缓解：`batchIndex` 改为单文件粒度写入 LanceDB，不再拼接跨文件大 OR |

---

## 遗留问题

### #2 [P1] Client 单例缓存旧 Key — Key 热替换不生效

**位置**：`src/api/embedding.ts:675-682`、`src/api/reranker.ts:244-248`

**现状**：

```typescript
let defaultClient: EmbeddingClient | null = null;
export function getEmbeddingClient(): EmbeddingClient {
  if (!defaultClient) {
    defaultClient = new EmbeddingClient();  // 只在首次调用时创建
  }
  return defaultClient;
}
```

`EmbeddingClient` 和 `RerankerClient` 均为模块级单例，构造时从 `getEmbeddingConfig()` 读取 Key 池并缓存。MCP 长驻进程中修改 `.env` 后 Key 不更新。

**影响**：与 #4（已修复）叠加——`badKeys` TTL 过期后 Key 恢复可用，但如果用户在 `badKeys` 冷却期更换了 `.env` 中的 Key，Client 单例持有的仍是旧 Key 池。

**建议方案**：
1. 导出 `resetEmbeddingClient()` / `resetRerankerClient()` 方法
2. 在 `scan()` 入口或每次 `index` 命令开始时调用 reset
3. 或改为每次 `getEmbeddingClient()` 对比当前 Key 列表是否变化

**关联 spec**：`docs/developer/spec-batch-index-resilience.md` 第 10 节。

---

### #3 [P1→P2] VectorStore.close() 未真正关闭 LanceDB 连接

**位置**：`src/vectorStore/index.ts:362-365`

**现状**：

```typescript
async close(): Promise<void> {
  this.db = null;      // 只置空引用
  this.table = null;   // native 资源未释放
}
```

**降级原因**：`@lancedb/lancedb` SDK 当前版本的 `Connection.prototype` 和 `Table.prototype` 均不暴露 `close()`、`disconnect()` 或类似 API。建议修复方案在 SDK 层面无法直接实施。

**影响**：MCP 长驻进程中，native 连接可能不被 GC 及时回收。但受限于 SDK 能力边界，实际风险低于 P1 定义。

**建议**：
1. 跟踪 LanceDB 版本更新，当 SDK 暴露关闭 API 时补充调用
2. 短期可确保引用及时置 null，让 V8 GC 回收

---

### #6 [P2] Logger WriteStream 从未显式关闭

**位置**：`src/utils/logger.ts:85`

**现状**：

```typescript
function createFormattedStream(filePath: string): Writable {
  const writeStream = fs.createWriteStream(filePath, { flags: 'a' });
  // ...
}
```

`createWriteStream` 创建的 `fs.createWriteStream` 在整个进程生命周期保持打开。CLI 短生命周期影响极小；MCP 长驻进程中，日志文件按日切换（`getLogFileName`），旧 stream 句柄未显式关闭。

**影响**：低风险。跨日运行时旧文件句柄未释放，但 Node.js 进程退出时会自动清理。

**建议方案**：
1. 在进程 SIGTERM/SIGINT 信号处理中显式关闭 logger stream
2. 在日期切换时 `oldStream.end()` 再创建新 stream

---

### #7 [P2] tokenBoundaryRegexCache 无上限增长

**位置**：`src/search/SearchService.ts:92`

**现状**：

```typescript
const tokenBoundaryRegexCache = new Map<string, RegExp>();
```

每次搜索的新 token 缓存一个 RegExp。MCP 长驻进程中，缓存随查询累积无限增长。

**影响**：短期可忽略（每个 RegExp ≈ 数十字节），长期运行（数万次查询）后可能积累数千条目。

**建议方案**：
1. 使用 LRU 缓存（例如 `lru-cache` 包，限制 `max: 1000`）
2. 或自行实现：`if (cache.size > 1000) { cache.delete(cache.keys().next().value) }`

---

### #9 [P3] 413 递归拆分潜在栈深度

**位置**：`src/api/embedding.ts:509-520`

**现状**：

```typescript
const leftResults = await this.processWithRateLimit(leftTexts, ...);
const rightResults = await this.processWithRateLimit(rightTexts, ...);
return [...leftResults, ...rightResults];
```

413 时递归调用拆分后的左右两部分。最大深度 = log₂(单批最大 texts 数) ≈ log₂(20) ≈ 4-5 层。

**影响**：极低。保护条件 `texts.length > 1` 阻止无限递归，实际深度很小。

**建议**：低优先级。未来可改为迭代式循环避免递归，但当前风险可忽略。

---

### #10 [P3] RateLimitController 全局单例状态跨 run 残留（部分缓解）

**位置**：`src/api/embedding.ts:316-325`

**现状**：

```typescript
let globalRateLimitController: RateLimitController | null = null;
```

模块级单例，`backoffMs` 和 `currentConcurrency` 状态在多次 scan 之间持久化。首轮修复已将 `successesPerConcurrencyIncrease` 从 3→10、`successesPerBackoffDecrease` 从 10→50、`minBackoffMs` 从 5000→10000，降低了状态跳变幅度，但**未消除跨 run 残留**。

**影响**：低。上一次 scan 末尾的高退避值可能短暂影响下次 scan 初始并发，但慢恢复策略降低了冲击。

**建议方案**：
1. 在 `scan()` 入口通过 `resetRateLimitController()` 重置状态
2. 或在 `RateLimitController` 上公开 `reset()` 方法

---

## 处理优先级

| 优先级 | ID | 问题 | 预估工作量 |
|--------|-----|------|-----------|
| **下一轮** | #2 | Client 单例缓存旧 Key | 小（~30 行 + 1 个测试） |
| 中期 | #3 | LanceDB close（跟踪 SDK） | 跟踪等待 |
| 中期 | #7 | tokenBoundaryRegexCache LRU | 小（~10 行） |
| 长期 | #6 | Logger WriteStream 关闭 | 中（信号处理） |
| 长期 | #10 | RateLimitController reset | 小（~15 行） |
| 低 | #9 | 413 递归改迭代 | 极小（~10 行） |
