---
name: coderecall-search
description: Use when you need to search a codebase semantically — find code by describing what it does, explore how a feature is implemented, locate relevant source files for a task, or understand the architecture of a project. Also use when CodeRecall isn't working (env not configured, index missing) and you need to diagnose or set it up. This skill should be used for ANY non-trivial code exploration task in a CodeRecall-indexed repository, even if the user doesn't explicitly mention "search" or "CodeRecall".
---

# CodeRecall 语义搜索指南

## 概述

CodeRecall 是语义检索引擎，采用混合搜索（向量 + 词法 + RRF 融合）。通过 CLI 命令 `coderecall search` 使用。

核心设计：**语义意图与精确术语分离**，两者通过 RRF 加权融合。

- `--information-request`：驱动向量语义搜索，理解"代码做什么"——这是主要通道
- `--technical-terms`：注入词法 FTS 通道，提升精确匹配的排名——仅在确定符号存在时使用
- 两通道结果经 RRF 加权融合（向量权重 0.6、词法权重 0.4），加 `--technical-terms` 不会排除纯语义匹配的结果

## 环境检查（任何搜索前必须先执行）

```bash
cat ~/.coderecall/.env
```

如果文件不存在，或 API Key 为占位符 `your-api-key-here`，告诉用户运行：

```bash
coderecall init
```

然后让用户编辑 `~/.coderecall/.env`，至少填写：

```env
EMBEDDINGS_API_KEYS=sk-xxx
EMBEDDINGS_BASE_URL=https://api.siliconflow.cn/v1/embeddings
EMBEDDINGS_MODEL=BAAI/bge-m3
RERANK_API_KEYS=sk-xxx
RERANK_BASE_URL=https://api.siliconflow.cn/v1/rerank
RERANK_MODEL=BAAI/bge-reranker-v2-m3
```

配置就绪后，首次使用需先建立索引。

## CLI 命令速查

```
coderecall search [options]
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `--repo-path <path>` | 否 | 仓库根目录，默认当前目录 |
| `--information-request <text>` | 是 | 自然语言描述功能/逻辑/行为 |
| `--technical-terms <terms>` | 否 | 精准术语，逗号分隔。**仅在100%确定符号存在时使用** |
| `--source-code-only` | 否 | 布尔标志，排除 markdown/json/yaml/toml/xml，仅搜索源码 |
| `--include-languages <langs>` | 否 | 语言白名单，逗号分隔，与 `--source-code-only` 互斥 |
| `--exclude-languages <langs>` | 否 | 语言黑名单，逗号分隔，可与 `--source-code-only` 组合 |

## 场景一：常规语义搜索

绝大多数情况只使用 `--information-request`，让语义引擎完成匹配。不要一上来就加 `--technical-terms`。

```bash
coderecall search \
  --information-request "How is the user authentication flow implemented"
```

```bash
coderecall search \
  --information-request "Database connection pool initialization and error recovery logic"
```

### 何时加 --technical-terms

仅在**以下两个条件同时满足**时才加：

1. 你已通过其他方式（刚读过文件、用户指出）确定某个类名/函数名/常量确实存在
2. 你想利用它提升该符号相关结果的排名

```bash
# 例如：刚读过 AuthService.ts，确定 AuthService 类存在
coderecall search \
  --information-request "How is the user authentication flow implemented" \
  --technical-terms "AuthService"
```

## 场景二：仅搜索源码

CodeRecall 将文件分为三类：

- **code（源码）**：typescript, javascript, python, go, rust, java, kotlin, swift, c_sharp, cpp, c, ruby, php, dart, lua, r, shell, powershell, sql, html, css, scss, sass, less, vue, svelte
- **docs（文档）**：markdown
- **config（配置）**：json, yaml, toml, xml

### 排除文档和配置（推荐）

```bash
coderecall search \
  --information-request "Error handling and recovery patterns" \
  --source-code-only
```

### 精确语言白名单

与 `--source-code-only` 互斥，不可同时使用：

```bash
coderecall search \
  --information-request "Database migration and schema management" \
  --include-languages "typescript,sql"
```

### 组合黑名单排除

可与 `--source-code-only` 组合，进一步排除不需要的源码类型：

```bash
coderecall search \
  --information-request "Build pipeline and compilation entry points" \
  --source-code-only \
  --exclude-languages "shell,powershell"
```

## 搜索策略决策流程

```
收到搜索任务
  ├─ 已知文件路径？→ 直接用 Read 工具读文件
  ├─ 探索性搜索？→ 仅用 --information-request
  ├─ 确定某符号存在且想提升其权重？→ 加上 --technical-terms
  ├─ 只关心业务逻辑代码？→ 加上 --source-code-only
  └─ 需要跨文件追踪？→ 多次搜索逐步缩小范围
```

## 常见错误

| 错误 | 正确做法 |
|------|----------|
| 随便猜测符号填入 `--technical-terms` | 不确定就留空，语义引擎已足够强大 |
| 同时用 `--source-code-only` 和 `--include-languages` | 两者互斥，选其一 |
| 忘记先检查环境配置 | 搜索前先 `cat ~/.coderecall/.env` |
| 未索引就直接搜索 | 先执行 `coderecall index` |

## 首次使用完整流程

```bash
# 1. 初始化配置
coderecall init

# 2. 编辑配置文件填写 API Key
vim ~/.coderecall/.env

# 3. 对项目建立索引（在项目目录下执行）
coderecall index

# 4. 搜索
coderecall search --information-request "How does X work"
```

## 辅助命令

```bash
# 查看索引健康状况
coderecall doctor .

# 修复孤儿记录
coderecall doctor . --repair

# 强制重建索引
coderecall index . --force

# 查看检索反馈摘要
coderecall feedback . --days 7 --top 10
```
