---
name: coderecall-search
description: Use when you need to search a codebase semantically — find code by describing what it does, explore how a feature is implemented, locate relevant source files for a task, or understand the architecture of a project. This skill should be used for ANY non-trivial code exploration task in a CodeRecall-indexed repository, even if the user doesn't explicitly mention "search" or "CodeRecall". Only fall back to its troubleshooting guidance when a search actually fails due to environment or index issues.
---

# CodeRecall 语义搜索指南

## 概述

CodeRecall 是语义检索引擎，采用混合搜索（向量 + 词法 + RRF 融合）。通过 CLI 命令 `coderecall search` 使用。

核心设计：**语义意图与精确术语分离**，两者通过 RRF 加权融合。

- `--information-request`：驱动向量语义搜索，理解"代码做什么"——这是主要通道
- `--technical-terms`：注入词法 FTS 通道，提升精确匹配的排名——仅在确定符号存在时使用
- 两通道结果经 RRF 加权融合（向量权重 0.6、词法权重 0.4），加 `--technical-terms` 不会排除纯语义匹配的结果

## 使用原则（重要）

**默认直接搜索，不要做前置检查。**

绝大多数情况下，用户的环境和索引已经就绪，应**直接执行 `coderecall search`**，不要先 `cat ~/.coderecall/.env`、不要先 `coderecall doctor`、不要先问"有没有建过索引"。

只有在**搜索命令实际失败**（报错、无结果、明显异常）时，才进入下方"故障排查"小节按需定位问题。**绝不把环境/索引检查作为每次搜索的前置动作。**

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

> 关于索引：**无需手动处理**。`coderecall search` 入口会调用 `ensureIndexed()`，首次自动全量索引、后续自动增量索引。仅当自动索引失败时才需人工介入，见下方"故障排查"。

## 故障排查（仅在搜索失败时使用）

**只在搜索命令报错、返回空、或明显异常时**才按下列步骤定位问题，正常情况下跳过本节。

### 1. 环境变量缺失

search 入口会自动校验 `EMBEDDINGS_*` / `RERANK_*` 环境变量。如果命令返回"配置缺失 / missing vars"类提示，按提示操作：

```bash
coderecall init               # 若 ~/.coderecall/.env 不存在
vim ~/.coderecall/.env        # 填写 API Key
```

最小配置：

```env
EMBEDDINGS_API_KEYS=sk-xxx
EMBEDDINGS_BASE_URL=https://api.siliconflow.cn/v1/embeddings
EMBEDDINGS_MODEL=BAAI/bge-m3
RERANK_API_KEYS=sk-xxx
RERANK_BASE_URL=https://api.siliconflow.cn/v1/rerank
RERANK_MODEL=BAAI/bge-reranker-v2-m3
```

### 2. 自动索引失败

`coderecall search` 入口会通过 `ensureIndexed()` 自动处理索引（首次全量、后续增量），**正常情况下无需手动 `coderecall index`**。

仅当日志/报错出现 scan 失败、写入失败、锁超时（`INDEX_LOCK_TIMEOUT`）等异常时，才人工介入：

```bash
coderecall index             # 手动触发一次索引
coderecall index . --force   # 强制重建
coderecall doctor .          # 审计向量索引与 chunks_fts 一致性
coderecall doctor . --repair # 修复孤儿记录
```

### 3. 首次使用完整流程（仅供首次安装参考）

```bash
coderecall init                # 1. 初始化配置
vim ~/.coderecall/.env         # 2. 填写 API Key
coderecall index               # 3. 建立索引（也可跳过，search 会自动建）
coderecall search --information-request "How does X work"  # 4. 搜索
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
