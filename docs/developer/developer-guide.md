# CodeRecall 开发者指南

> 本文承接 README 中的开发者专用内容，聚焦回归测试、评测调参与维护者发版流程。

## 1. 项目回归测试（开发者）

```bash
# 全量单元测试入口（runtime + benchmark）
npm run test:unit:all

# 语言支持与运行时回归（不含 benchmark）
npm test

# 离线 benchmark 基线（Recall@K / MRR / nDCG）
npm run test:benchmark
npm run benchmark:offline

# MCP 多语言端到端冒烟测试
npm run test:e2e:mcp
```

离线评测默认样例数据位于
`tests/benchmark/fixtures/sample-offline-benchmark.jsonl`。

```bash
# 自定义数据集与 K 列表
node --loader tsx src/search/eval/runOfflineBenchmark.ts path/to/dataset.jsonl --k 1,3,5,10
```

## 2. 离线自动调参（P4）

```bash
# 运行自动调参单元测试
npm run test:benchmark

# 使用样例数据集执行调参
npm run benchmark:tune

# 通过 CLI 调参（支持自定义 target/k/grid）
coderecall tune tests/benchmark/fixtures/sample-auto-tune-dataset.jsonl --target mrr --k 1,3,5 --top 5
```

调参数据集最小字段：
`id/query/vectorRetrieved/lexicalRetrieved/relevant`。

## 3. 隐式反馈闭环摘要（P4）

```bash
# 查看最近 7 天隐式反馈摘要
coderecall feedback . --days 7 --top 10
```

输出包含：`totalEvents`、`zeroHitRate`、`implicitSuccessRate`
及高复用文件 TopN。

## 4. 索引一致性审计（P3）

```bash
# 检查向量索引与 chunks_fts 一致性
coderecall doctor .

# 自动修复：删除 chunks_fts 中无对应向量的孤儿记录
coderecall doctor . --repair
```

## 5. 发布（维护者）

如果你要一次性发布全部插件包（不含主包），可直接使用脚本：

```bash
# 先做发布前校验
npm install
npm test
npm run build
npm run --workspaces --if-present build

# 演练（不真正发布）
bash scripts/publish-plugins.sh --version <x.y.z> --dry-run

# 正式发布（会自动跳过 npm 上已存在的版本）
bash scripts/publish-plugins.sh --version <x.y.z>
```

可选参数：

- `--tag <tag>`：指定 npm dist-tag（默认 `latest`）
- `--provenance`：强制附带 provenance（需支持 OIDC 的 CI）
- `--no-provenance`：禁用 provenance
- `--allow-version-mismatch`：允许与 `--version` 不一致的插件包直接跳过
- 不传 `--version`：按各插件目录下 `package.json` 的 version 发布

> provenance 默认是 auto：本地环境自动关闭，CI（含 OIDC）自动开启。
> 发布顺序与 CI 一致：单语言包 -> `lang-all`。
>
> 发版补充文档：
> - 全量本地手动发版：`docs/release/local-manual-release.md`
> - 仅主包发版：`docs/release/main-package-only-release.md`

## 6. 环境变量配置参考

> 本节是完整配置参考，面向开发者和需要精细调优的用户。终端用户只需按 README "初始化配置" 小节填写 6 个必需变量即可。

配置文件位置：`~/.coderecall/.env`（生产环境默认；开发环境会先尝试 `cwd/.env`，再回退到 `~/.coderecall/.env`）。

### 6.1 必需变量

| 变量名 | 描述 |
|--------|------|
| `EMBEDDINGS_API_KEYS` | Embedding API Key，逗号分隔多 Key 轮转 |
| `EMBEDDINGS_BASE_URL` | Embedding API 地址 |
| `EMBEDDINGS_MODEL` | Embedding 模型名称 |
| `RERANK_API_KEYS` | Reranker API Key，逗号分隔多 Key 轮转 |
| `RERANK_BASE_URL` | Reranker API 地址 |
| `RERANK_MODEL` | Reranker 模型名称 |

### 6.2 常用可选变量

| 变量名 | 默认值 | 描述 |
|--------|--------|------|
| `EMBEDDINGS_DIMENSIONS` | 1024 | 向量维度（与模型匹配） |
| `CODE_RECALL_PROFILE` | balanced | 索引分片档位：`quality` / `balanced` / `performance` |
| `EMBEDDINGS_RATE_PROFILE` | balanced | Embedding 限流档位：`safe` / `balanced` / `fast` |
| `RERANK_TOP_N` | 20 | Rerank 返回数量 |
| `INCLUDE_PATTERNS` | - | 额外包含模式，用于显式纳入未知扩展名（逗号分隔） |
| `IGNORE_PATTERNS` | - | 额外忽略模式（逗号分隔） |
| `LOG_LEVEL` | info | 日志级别；设 `debug` 可输出详细检索日志到 `~/.coderecall/logs/app.YYYY-MM-DD.log` |

### 6.3 多 Key 轮转与旧变量兼容

- 推荐使用 `_KEYS` 后缀变量（逗号分隔多 Key），在限流压力大时通过请求级轮转分摊压力。
- 旧变量名 `EMBEDDINGS_API_KEY` 和 `RERANK_API_KEY` 运行时仍兼容；当 `_KEY` 与 `_KEYS` 同时存在时，`_KEYS` 优先。

### 6.4 高级限流覆盖

如需精确控制限流（例如对接自有 API 网关的配额），可继续使用以下变量；未配置时由 `EMBEDDINGS_RATE_PROFILE` 自动给出默认值：

| 变量名 | 描述 |
|--------|------|
| `EMBEDDINGS_MAX_CONCURRENCY` | 全局最大并发 |
| `EMBEDDINGS_MAX_RPM` | 全局每分钟请求上限 |
| `EMBEDDINGS_MAX_TPM` | 全局每分钟 Token 上限 |
| `EMBEDDINGS_KEY_MAX_CONCURRENCIES` | 按 Key 对齐的并发上限列表（逗号分隔，与 `_KEYS` 顺序对齐） |
| `EMBEDDINGS_KEY_MAX_RPMS` | 按 Key 对齐的 RPM 列表 |
| `EMBEDDINGS_KEY_MAX_TPMS` | 按 Key 对齐的 TPM 列表 |

源码真相：`src/config.ts` 的 `DEFAULT_ENV_TEMPLATE` 与 `getEmbeddingConfig()` / `getRerankerConfig()`。
