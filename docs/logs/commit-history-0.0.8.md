# Commit History（0.0.8）

> 日期：2026-02-10
> 目标：完成 Node 24 兼容发布链路、插件命名升级（`lang-all + 单语言包`）、本地手动发版能力与文档闭环。

## 1. 发布策略与兼容性

### 1.1 Node 版本策略

- 主包 `engines.node` 调整为 `>=20 <25`
- 支持 Node 24 安装与运行验证

### 1.2 Tree-sitter 依赖策略

- 主包回归官方 `tree-sitter@^0.25.0`
- 主包仅保留内置语言运行时（JavaScript / Python / Go）
- 可选语言能力迁移至插件包

### 1.3 避免安装告警

- 处理 `tree-sitter-cpp -> tree-sitter-c` 版本告警链路
- 在相关包中固定 `tree-sitter-c@0.23.1`，减少 peer 警告

## 2. Runtime 架构升级

### 2.1 Runtime 抽象

- 新增统一运行时接口：`LanguageRuntime`
- 新增运行时注册器：`RuntimeRegistry`
- 新增内置 runtime：`BuiltinRuntimeTs25`
- 新增插件自动发现：`PluginLoader`

### 2.2 插件加载优先级

默认候选顺序调整为：

1. `lang-all`
2. 单语言插件（typescript/kotlin/csharp/cpp/java/ruby/c/php/rust/swift）
3. 兼容插件（`lang-ts21` / `lang-ts22`）

### 2.3 解析器池接入

- `ParserPool` 接入 runtime 初始化与插件发现
- 保持缺失插件时的平滑回退能力

## 3. 多包工作区与插件生态

### 3.1 新增插件包

- `packages/lang-all`
- `packages/lang-typescript`
- `packages/lang-kotlin`
- `packages/lang-csharp`
- `packages/lang-cpp`
- `packages/lang-java`
- `packages/lang-ruby`
- `packages/lang-c`
- `packages/lang-php`
- `packages/lang-rust`
- `packages/lang-swift`

### 3.2 兼容插件保留

- `packages/lang-ts21`
- `packages/lang-ts22`

> 兼容包保留发布能力，但新用户推荐 `lang-all` 或单语言包。

### 3.3 工作区配置

- 新增 `pnpm-workspace.yaml`
- 新增 `.npmrc`（workspace 链接策略）

## 4. 发布流水线与本地发布能力

### 4.1 CI 发布流程

- `release.yml` 升级为多包发布流水线
- 校验所有包版本与 tag 一致性
- 发布顺序：单语言包 -> `lang-all` -> 兼容包 -> 主包

### 4.2 安装冒烟

- 新增 `smoke-install.yml`
- 覆盖 Node 20/22/24 + npm/pnpm 维度

### 4.3 本地发布脚本

- 新增 `scripts/publish-plugins.sh`
- 支持：`--version`、`--tag`、`--dry-run`
- provenance 改为 auto：
  - 本地默认关闭
  - OIDC CI 自动开启
  - 可手动 `--provenance` / `--no-provenance`

### 4.4 打包白名单

- 所有插件包新增 `files` 白名单，仅发布 `dist/**/*.js` 与 `dist/**/*.d.ts`
- `.gitignore` 新增 `*.tgz`，避免打包产物污染提交

## 5. 文档与测试

### 5.1 README 更新

- 安装文档切换为 `lang-all + 单语言包`
- 保留兼容包说明
- 增补 Node24、pnpm 构建批准与重建 FAQ
- 增补 MCP 自动索引 FAQ
- 增补“插件整体发布（维护者）”章节

### 5.2 新增手册

- `docs/release/local-manual-release.md`：本地手动发版操作手册（独立文档）

### 5.3 回归测试

- `tests/runtime/plugin-loader.test.ts`
- `tests/runtime/workspace-packages.test.ts`
- `tests/runtime/docs-guard.test.ts`
- `tests/install/node24-smoke.mjs`
- 其他 runtime 相关回归测试补充

## 6. 验证记录（本轮）

已执行（通过）：

- `pnpm install --frozen-lockfile`
- `pnpm test`
- `pnpm -r build`
- `npm pack --dry-run`
- `bash scripts/publish-plugins.sh --version 0.0.8 --dry-run`

备注：

- `pnpm test:e2e:mcp` 受外部 Embedding 网络影响，属于环境相关波动项，不作为本次提交阻断条件。
