# Spec: batchIndex 断点续传 & 多 Key 容错

## 1. 概述

**目标**：让 `batchIndex` 在 Embedding API 出错（Key 过期、网络抖动）时具备断点续传和 Key 自动切换能力，避免全量回滚。

**背景**：当前 `batchIndex` 采用"全收集 → 全 Embedding → 全写入"的原子模式。任意批次 Embedding 失败时，已成功的进度全部丢失，用户需要从零重跑。审计报告（`audit-index-pipeline-2026-06-02.md`）将其列为 P0 问题。

**改动范围预估**：~200 行，涉及 2 个文件。

---

## 2. 现状分析

### 2.1 流水线全景

```
scan()
  └→ indexFiles()
      ├→ 按 hash 分类文件：added / modified / unchanged / deleted
      │   └→ unchanged → 跳过（这就是"断点"的锚点）
      ├→ 删除已删除文件的旧向量
      └→ batchIndex(toIndex)  ← 本条 spec 聚焦的改动点
```

### 2.2 batchIndex 当前 6 阶段（src/indexer/index.ts:275-430）

```
阶段 1: 收集
  遍历所有 files，收集所有 chunk.vectorText → allTexts[]

阶段 2: Embedding
  embedBatch(allTexts, 20)  → 一次性提交所有文本
  │
  └─ ❌ catch: clearVectorIndexHash(所有文件) → 全量回滚！

阶段 3: 组装 ChunkRecord（内存）
阶段 4: LanceDB 批量写入
  │
  └─ ❌ catch: clearVectorIndexHash(所有文件) → 全量回滚！

阶段 5: FTS 批量更新（容忍失败，只 warn）
阶段 6: batchUpdateVectorIndexHash(successFiles)  ← 标记完成
```

**断点锚点机制**：`vector_index_hash` 字段。
- hash 匹配 → `unchanged` → 跳过索引
- hash 不匹配 → `modified` → 重新索引
- 不存在 → `added` → 新索引

**问题**：hash 只在阶段 6 写入。阶段 2/4 失败时，下次 scan 时 hash 为空（或被 clearVectorIndexHash 清空）→ 全部变成 added/modified → 从零重来。

### 2.3 Embedding API Key 轮转现状（src/api/embedding.ts:361-364）

```
getNextApiKey():
  key = apiKeyPool[currentIndex]
  currentIndex = (currentIndex + 1) % pool.length
  return key
```

- 纯 round-robin，无状态追踪
- 每次 `processBatch()` 调用取一次 Key

### 2.4 processWithRateLimit 错误分类现状（src/api/embedding.ts:435-533）

```
while (true) {
  acquire() → try processBatch(texts, key) {
    if 429       → 退避后重试（同一 Key）
    if network   → 退避后重试（同一 Key）
    if 413       → 拆半递归
    else         → throw ← 401/403 命中这里，直接炸穿
  }
}
```

**盲区**：401/403 被当作不可恢复错误，直接抛出。即使池子里还有可用 Key，也不会尝试切换。

### 2.5 embedBatch 内部并发模型

```
embedBatch(allTexts, batchSize=20):
  batches = split(texts, 20)          // 500 texts → 25 批次
  Promise.all(batches.map(batch => processWithRateLimit(batch)))  // 25 次并发 acquire
```

`processWithRateLimit` 入口处 `acquire()` 受 `MAX_CONCURRENCY` 限制。如果 `MAX_CONCURRENCY < 25`，多余批次排队等待；如果 `MAX_CONCURRENCY >= 25`，25 个请求同时发出。

---

## 3. 问题定义

| # | 问题 | 影响 |
|---|------|------|
| P0 | Embedding 失败全量回滚 | 大项目索引到 90% 后失败，换 Key 后需从零重跑 |
| P1 | 坏 Key 无跳过机制 | 池中 1/3 Key 过期 → 33% 请求先失败再重试 |
| P2 | 全量 texts+embeddings 同时驻留内存 | 大项目内存峰值数百 MB |

---

## 4. 设计方案

### 4.1 核心思路：大原子 → 小原子

将 `batchIndex` 从"全量原子"改为"按 Chunk 数动态分批的小批次原子"。每个小批次独立完成 收集→Embedding→写库→标记 hash 的闭环。

```
改造后：

for (每批阶段，按 BATCH_CHUNKS 个 chunk 分组) {
  ├─ 收集 这批文件的 texts
  ├─ embedBatch(这批 texts) ─── 失败 → 只 clear 这批的 hash，continue
  ├─ 组装 ChunkRecord
  ├─ LanceDB 写入 ─── 失败 → 先清理半写入数据，再 clear hash，continue
  ├─ FTS 更新
  └─ batchUpdateVectorIndexHash(这批文件)  ← 逐批标记完成
}
```

**效果**：进度以批次为粒度保存。中断后重启 scan，已标记 hash 的文件 → `unchanged` → 自动跳过。

### 4.2 分批粒度设计（应对并发风暴）

**设计决策**：按 Chunk 数动态分组，而非固定文件数。目标是控制每批 Embedding 请求的并发数在可控范围。

```typescript
// 配置常量
const BATCH_CHUNKS = 400;         // 每批最多 400 个 chunk（≈20 个 API 并发请求）
const EMBED_BATCH_SIZE = 20;      // 每个 API 请求包含 20 条文本

// 分组逻辑
function splitIntoChunkBatches(files: FileToIndex[], maxChunks: number): FileToIndex[][] {
  const batches: FileToIndex[][] = [];
  let current: FileToIndex[] = [];
  let currentChunkCount = 0;

  for (const file of files) {
    if (currentChunkCount + file.chunks.length > maxChunks && current.length > 0) {
      batches.push(current);
      current = [file];
      currentChunkCount = file.chunks.length;
    } else {
      current.push(file);
      currentChunkCount += file.chunks.length;
    }
  }
  if (current.length > 0) batches.push(current);

  return batches;
}
```

**并发分析**：
- 每批 400 chunks ÷ 20 chunk/请求 = 20 个并发 API 请求
- `MAX_CONCURRENCY` 默认值通常 ≥ 20，不会造成额外排队
- 如果单文件 chunk 数巨大（>400），该文件单独成批，不会阻塞其他文件
- 经验值：400 chunks ≈ 50 个平均 8 chunk 的文件，等价于原 `BATCH_FILES=50` 的典型场景

### 4.3 batchIndex 改造（src/indexer/index.ts）

**改动位置**：`batchIndex()` 方法（行 275-430），整段重写。

**改动前的逻辑**：
```typescript
// 全量收集
const allTexts = files.flatMap(f => f.chunks.map(c => c.vectorText));

// 一次性 Embedding
const embeddings = await embeddingClient.embedBatch(allTexts, 20, onProgress);
// ❌ catch: clearVectorIndexHash(all files); return {0, N};

// 组装 + 写库
// ❌ catch: clearVectorIndexHash(all files); return {0, N};

// 标记完成
batchUpdateVectorIndexHash(db, successFiles);
```

**改动后的逻辑**：
```typescript
// 按 Chunk 数分组（内联在 batchIndex 中实现）
const batches = splitIntoChunkBatches(files, BATCH_CHUNKS);
let totalSuccess = 0;
let totalErrors = 0;

for (const batch of batches) {
  // === 子原子操作开始 ===

  // 1. 收集本批 texts + 构建索引映射
  const { texts, chunkRefs } = collectTexts(batch);
  // chunkRefs: Array<{ fileIdx, filePath, chunkIdx, globalTextIdx }>

  // 2. Embedding
  let embeddings: number[][];
  try {
    embeddings = await client.embedBatch(texts, EMBED_BATCH_SIZE, onProgress);
  } catch (err) {
    logError(err, 'Embedding 失败');
    clearVectorIndexHash(db, batch.map(f => f.path));
    totalErrors += batch.length;
    continue; // ← 继续下一批
  }

  // 3. 组装 ChunkRecord 并写 LanceDB
  const { successFiles, errorFiles } = await assembleAndWrite(
    db, batch, embeddings, chunkRefs
  );
  // 如果 LanceDB 写入失败，assembleAndWrite 内部已清理半写入数据

  // 4. FTS 更新
  updateFts(db, successFiles);

  // 5. 标记完成 ← 关键：逐批写 hash
  if (successFiles.length > 0) {
    batchUpdateVectorIndexHash(db, successFiles);
  }

  totalSuccess += successFiles.length;
  totalErrors += errorFiles.length;
}

return { success: totalSuccess, errors: totalErrors };
```

**修改要点**：
- `splitIntoChunkBatches` 按 chunk 数动态分组（内联实现，不抽模块）
- `collectTexts` 收集本批 texts 并建立 `chunkRefs` 索引表（内联实现）
- `assembleAndWrite` 组装 ChunkRecord 并写 LanceDB，失败时先清理半写入数据（见 4.4）
- `updateFts` 批量更新 FTS（复用现有函数）
- `catch` 块从 `clearVectorIndexHash(allFiles)` 改为 `clearVectorIndexHash(batchFiles)`
- `batchUpdateVectorIndexHash` 从"最后一次性"改为"每批完成后"调用
- 用 `continue` 代替 `return`，失败批次不阻断后续批次

### 4.4 LanceDB 写入失败处理

**问题**：`batchUpsertFiles` 可能部分写入后失败（非原子），造成脏数据。
- 部分向量已写入 LanceDB
- hash 被 clear → 下次 scan 重新处理
- 重新处理时 upsert（按 `chunk_id` 主键）幂等覆盖，**不会产生重复数据**
- 但如果文件 hash 变化导致 `chunk_id` 变化，旧 `chunk_id` 的记录会成为孤儿

**方案**：LanceDB 写入失败时，先清理已写入的旧向量再 continue。

```typescript
async function assembleAndWrite(
  db, batch, embeddings, chunkRefs
): Promise<{ successFiles, errorFiles }> {

  const successFiles: Array<{ path: string; hash: string }> = [];
  const errorFiles: string[] = [];

  for (const file of batch) {
    try {
      const records = buildRecordsForFile(file, embeddings, chunkRefs);
      // 单文件写入（幂等 upsert）
      await vectorStore.batchUpsertFiles([{ path: file.path, hash: file.hash, records }]);
      successFiles.push({ path: file.path, hash: file.hash });
    } catch (err) {
      // 清理该文件可能已写入的旧向量（按 file_path 删除）
      try { await vectorStore.deleteFile(file.path); } catch { /* 尽力清理 */ }
      errorFiles.push(file.path);
    }
  }

  return { successFiles, errorFiles };
}
```

**设计选择**：按单文件粒度写入，而非按批次。单文件写入失败只影响一个文件，且 `deleteFile` 保证清理彻底。

### 4.5 API Key 容错改造（src/api/embedding.ts）

#### 4.5.1 重试循环中 Key 的获取时机

**核心规则**：
- 429 / 网络错误重试 → **复用同一个 Key**（不需要换 Key，Key 没问题）
- 401/403 重试 → **切换到下一个健康 Key**
- 首次进入循环 → **取一个新 Key**

```typescript
private async processWithRateLimit(texts, startIndex, progress, signal) {
  let networkRetries = 0;
  let currentKeyIndex: number | null = null;   // null = 下次循环重新取
  let currentApiKey: string | null = null;

  while (true) {
    // 获取执行槽位
    await this.rateLimiter.acquire();

    try {
      // 如果 Key 为空（首次或 401 换 Key 后），取新 Key
      if (currentKeyIndex === null) {
        currentKeyIndex = this.getNextKeyIndex();   // 内部跳过 badKeyIndices
        currentApiKey = this.apiKeyPool[currentKeyIndex];
      }

      const result = await this.processBatch(texts, startIndex, progress, signal, currentApiKey);
      this.rateLimiter.releaseSuccess();
      return result;

    } catch (err) {
      const isRateLimited = ...;
      const isNetworkError = ...;
      const isPayloadTooLarge = ...;
      const isAuthError = is401or403(err);

      if (isRateLimited || isNetworkError) {
        // 429 / 网络：复用同一 Key，不换
        this.rateLimiter.releaseForRetry();
        await sleep(backoffMs);
        // currentKeyIndex 保持不变 → 下次循环复用
      } else if (isAuthError && this.apiKeyPool.length > 1) {
        // 401/403：标记坏 Key，下次循环重新取
        this.markKeyBad(currentKeyIndex!);
        currentKeyIndex = null;   // ← 触发下次循环重新取 Key
        this.rateLimiter.releaseForRetry();
      } else if (isPayloadTooLarge && texts.length > 1) {
        // 413：拆分递归（保持 Key 传递逻辑不变）
        this.rateLimiter.releaseForRetry();
        // 拆分后的子调用各自独立取 Key
        return await this.handlePayloadSplit(texts, startIndex, progress, signal);
      } else {
        throw err;
      }
    }
  }
}
```

**Key 传递链路**：
```
processWithRateLimit()
  ├─ 取 Key → getNextKeyIndex() → 传入 processBatch(key)
  │
  ├─ 429  → 复用 key，不换
  ├─ 网络  → 复用 key，不换
  ├─ 401/403 → markKeyBad() + keyIndex = null → 下次循环重新取
  └─ 413 → 拆半后的子调用各自取 Key（原递归逻辑保留）
```

#### 4.5.2 坏 Key 跳过 + TTL 恢复机制

**改动位置**：`getNextApiKey()`（行 361-364）。

```typescript
private badKeys = new Map<number, number>();  // keyIndex → banUntil (timestamp ms)
private readonly BAD_KEY_BAN_MS = 5 * 60 * 1000; // 5 分钟冷却

private getNextKeyIndex(): number {
  const now = Date.now();

  // 清理已经过冷却期的坏 Key
  for (const [idx, banUntil] of this.badKeys) {
    if (now >= banUntil) this.badKeys.delete(idx);
  }

  const start = this.nextApiKeyIndex;
  for (let i = 0; i < this.apiKeyPool.length; i++) {
    const idx = (start + i) % this.apiKeyPool.length;
    const banUntil = this.badKeys.get(idx);
    if (banUntil === undefined || now >= banUntil) {
      this.badKeys.delete(idx); // 过期后清除标记
      this.nextApiKeyIndex = (idx + 1) % this.apiKeyPool.length;
      return idx;
    }
  }

  // 所有 Key 都在冷却期 → 重置并重试
  this.badKeys.clear();
  this.nextApiKeyIndex = 0;
  return 0;
}

private markKeyBad(index: number): void {
  const banUntil = Date.now() + this.BAD_KEY_BAN_MS;
  this.badKeys.set(index, banUntil);
  logger.warn({ keyIndex: index, banUntil }, 'API Key 已标记为不可用，5 分钟后重新尝试');
}
```

**设计要点**：
- 使用 `Map<index, banUntil>` 替代 `Set<index>`，支持 TTL 自动恢复
- 5 分钟冷却期，避免临时限流导致 Key 永久丢失
- `getNextKeyIndex` 每次调用主动清理过期标记

---

## 5. 改动清单

| 文件 | 段落 | 改动量 | 说明 |
|------|------|--------|------|
| `src/indexer/index.ts` | `batchIndex()` 整段重写 | ~80 行 | 外层 for 循环 + `splitIntoChunkBatches` + `collectTexts` + `assembleAndWrite`（内联） |
| `src/indexer/index.ts` | `splitIntoChunkBatches()` | ~15 行（新增） | 按 chunk 数分组 |
| `src/indexer/index.ts` | `assembleAndWrite()` | ~25 行（新增） | 单文件粒度写库 + 失败清理 |
| `src/api/embedding.ts` | `getNextApiKey()` → `getNextKeyIndex()` | ~20 行 | 返回索引 + `badKeys` TTL Map |
| `src/api/embedding.ts` | `markKeyBad()` | +5 行（新增） | 标记坏 Key + 冷却期 |
| `src/api/embedding.ts` | `processWithRateLimit()` while 循环 | ~30 行 | 新增 `isAuthError` 分支 + Key 变量管理 |
| `src/api/embedding.ts` | `processBatch()` 签名 | ~5 行 | 接收外部传入的 `apiKey` 参数 |

**总计**：~180 行。

**不动**：Scanner、VectorStore（`batchUpsertFiles`/`deleteFile` 已有）、FTS、DB 工具函数、scan() 编排逻辑、hash 检测分类逻辑、配置加载。

---

## 6. 边界情况

| 场景 | 预期行为 |
|------|---------|
| 所有 Key 都坏 | `badKeys` 全部在冷却期 → 重置后按原行为抛异常 |
| 仅 1 个 Key 且过期 | `isAuthError` 不触发切换（`pool.length > 1` 守卫），保持当前行为 |
| Key 临时限流被判为 401 | 标记为坏 → 5 分钟后 TTL 过期自动恢复 → 下次 scan 重新尝试 |
| 网络抖动导致某批失败 | 重试 3 次（已有机制），不标记 Key 为坏 |
| 429 限速 | 退避后继续（已有机制），复用同一 Key，不换 |
| LanceDB 写入某文件失败 | 先 `deleteFile` 清理半写入 → 标记该文件为失败 → 继续下一文件 |
| 进程 kill（在 LanceDB 写完后、hash 标记前）| 向量已在 LanceDB，hash 未写 → 下次 scan：文件 hash 未变 → `modified` → 重新 Embedding + upsert 覆盖（幂等） → 额外 API 开销，**不丢数据** |
| 进程 kill（在 hash 标记后）| 文件标记为 `unchanged` → 下次 scan 跳过 ✅ |
| 单文件 chunk 数 > BATCH_CHUNKS (400) | 该文件单独成批 |
| 文件 chunks 为空 | `noChunkSettled` 路径不受影响（不在 `toIndex` 中） |

---

## 7. 风险与影响

| 风险 | 等级 | 说明 |
|------|------|------|
| LanceDB 写入从批量改单文件 | 中 | 写吞吐可能下降，需实测。但单文件粒度换来清理便利和失败隔离 |
| 进程 kill 导致重复 Embedding | 低 | 可接受开销，数据不丢失 |
| Bad Key TTL 期间仍使用坏 Key（极端） | 低 | 仅在所有 Key 都坏 + 冷却期未到时触发重置，重置后可能再用坏 Key 一次 |
| API 调用次数微增 | 无 | embedBatch 内部已按每 20 条分批，总调用数不变 |
| 向后兼容 | 无 | `batchIndex` 和 `indexFiles` 签名不变 |

---

## 8. 测试策略

### 单元测试

1. **splitIntoChunkBatches 分组正确性**：验证按 chunk 数切分、单大文件单独成批
2. **正常流程**：3 批文件全部成功 → 全部标记 hash
3. **中间批次 Embedding 失败**：第 1 批成功（hash 已写），第 2 批失败（hash 清除），第 3 批成功（hash 已写）→ 重启 scan 后只处理第 2 批
4. **LanceDB 单文件写入失败**：批次中某文件写入失败 → 该文件旧向量被清理 → hash 被标记为失败 → 其他文件不受影响
5. **单 Key 过期**：行为不变（抛异常）
6. **多 Key 中 1 个过期**：自动跳过坏 Key，用健康 Key 完成批次
7. **坏 Key TTL 恢复**：标记 5 分钟后，`badKeys` 该项被清除，Key 恢复可用
8. **全部 Key 过期**：badKeys 全部冷却期 → 重置后按原行为抛异常
9. **429 重试不换 Key**：验证 429 场景下 `currentKeyIndex` 保持不变

### 集成测试

10. **断点续传端到端**：索引 3 批文件（共 ~1000 chunks）→ 在第 2 批 Embedding 前中断 → 重启 scan → 验证第 1 批被跳过 (`unchanged`)，第 2、3 批被处理
11. **hash 检测正确性**：已完成批次文件在后续 scan 中被标记为 `unchanged`

---

## 9. 与审计报告的关系

本 spec 覆盖审计报告 `audit-index-pipeline-2026-06-02.md` 中的以下发现：

| 报告 ID | 发现 | 本 spec 处理 |
|---------|------|-------------|
| #1 (P0) | Embedding 失败全量回滚 | ✅ 分批逐落盘 |
| #4 (P1) | Key 轮询无坏 Key 跳过 | ✅ badKeys Map + TTL |
| #5 (P2) | 全量 texts+embeddings 内存峰值 | ✅ 按 chunk 数动态分批 |
| #2 (P1) | Client 单例缓存旧 Key | ❌ 不在本 spec（见后续 TODO） |

---

## 10. 后续 TODO

### 10.1 Client 单例缓存旧 Key（审计 #2）

**问题**：`getEmbeddingClient()` 和 `getRerankerClient()` 使用模块级单例，构造时从 `getEmbeddingConfig()` 读取 Key。MCP 长驻进程中修改 `.env` 后 Key 不更新。

**不在本 spec 范围的原因**：该问题涉及单例生命周期管理和配置热加载，与本 spec 的批处理容错正交。单独处理可降低改动耦合。

**建议处理方式**：
1. 在 `embedding.ts` / `reranker.ts` 中导出 `resetEmbeddingClient()` / `resetRerankerClient()`
2. 在 `scan()` 入口或 index 命令开始时调用 reset
3. 或改为每次 `getEmbeddingClient()` 时对比当前 Key 列表是否变化，变化则重建

### 10.2 LanceDB 写入性能回退监控

单文件写入替代批量写入可能降低吞吐。实施后需跑 benchmark 对比，如果回退显著（>20%），考虑：
- 恢复批量写入改为原子批次 `try { batchUpsert } catch { deleteFiles }`
- 或使用 LanceDB transaction（如果 SDK 支持）
