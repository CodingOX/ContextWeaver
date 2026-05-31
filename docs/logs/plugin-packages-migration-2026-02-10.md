# 插件化迁移说明（2026-02-10）

## 背景

`tree-sitter-*` 语法包的 peer 区间分裂在 `^0.21`、`^0.22`、`^0.25` 三个生态。
单包同时依赖全部语法包时，npm 安装阶段容易出现 `ERESOLVE overriding peer dependency` 警告。

本次迁移将主包与语法包解耦，目标是：

1. 在 Node 24 下可安装可运行
2. 默认安装尽量无 `tree-sitter` peer 冲突 warn
3. 保留“未安装插件时不阻断索引”的兜底行为

## 变更摘要

### 1) 主包内置语言（`tree-sitter@^0.25`）

主包仅保留：

- JavaScript
- Python
- Go

### 2) 可选插件包

- `@alistar.max/contextweaver-lang-ts21`
  - 适配 `tree-sitter@^0.21`
  - 提供：TypeScript / Kotlin / C# / C++ / Java / Ruby

- `@alistar.max/contextweaver-lang-ts22`
  - 适配 `tree-sitter@^0.22`
  - 提供：C / PHP / Rust / Swift

### 3) 运行时机制

- 主包启动时注册内置运行时
- 通过 `PluginLoader` 动态发现可选插件（失败仅 warn，不抛错）
- 语言无 AST 运行时时，回退到纯文本分片

## 用户迁移指引

### 仅安装主包（默认）

```bash
npm install -g @alistar.max/contextweaver
```

### 按需安装插件

```bash
npm install -g @alistar.max/contextweaver-lang-ts21
npm install -g @alistar.max/contextweaver-lang-ts22
```

## 回滚方案

若插件机制出现回归，可临时回退到 `0.0.7`：

```bash
npm install -g @alistar.max/contextweaver@0.0.7
```
