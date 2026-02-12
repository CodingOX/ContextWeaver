# ContextWeaver 开发者指南

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
contextweaver tune tests/benchmark/fixtures/sample-auto-tune-dataset.jsonl --target mrr --k 1,3,5 --top 5
```

调参数据集最小字段：
`id/query/vectorRetrieved/lexicalRetrieved/relevant`。

## 3. 隐式反馈闭环摘要（P4）

```bash
# 查看最近 7 天隐式反馈摘要
contextweaver feedback . --days 7 --top 10
```

输出包含：`totalEvents`、`zeroHitRate`、`implicitSuccessRate`
及高复用文件 TopN。

## 4. 索引一致性审计（P3）

```bash
# 检查向量索引与 chunks_fts 一致性
contextweaver doctor .

# 自动修复：删除 chunks_fts 中无对应向量的孤儿记录
contextweaver doctor . --repair
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
> 发布顺序与 CI 一致：单语言包 -> `lang-all` -> 兼容包（`lang-ts21`/`lang-ts22`）。
>
> 发版补充文档：
> - 全量本地手动发版：`docs/release/local-manual-release.md`
> - 仅主包发版：`docs/release/main-package-only-release.md`
