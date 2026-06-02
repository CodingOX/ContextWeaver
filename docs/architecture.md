# 🧠 CodeRecall Architecture

> **CodeRecall** 是一个专为 AI 代码助手设计的语义检索引擎，结合了混合检索、上下文图扩展以及精确的 Token 打包控制策略。

以下是高度浓缩的核心架构流程图，展示了从索引构建到检索分析的完整生命周期。

## 🏗️ 核心架构图 (Core Pipeline)

```mermaid
flowchart TD
    %% --- Premium Aesthetics Definitions ---
    classDef client fill:#1E293B,stroke:#475569,stroke-width:2px,color:#F8FAFC,rx:8,ry:8;
    classDef entry fill:#2563EB,stroke:#1D4ED8,stroke-width:2px,color:#FFFFFF,shadow:true,rx:8,ry:8;
    classDef core fill:#7C3AED,stroke:#6D28D9,stroke-width:2px,color:#FFFFFF,shadow:true,rx:12,ry:12;
    classDef pipeline fill:#059669,stroke:#047857,stroke-width:2px,color:#FFFFFF,rx:6,ry:6;
    classDef logic fill:#D97706,stroke:#B45309,stroke-width:2px,color:#FFFFFF,rx:6,ry:6;
    classDef storage fill:#DC2626,stroke:#B91C1C,stroke-width:2px,color:#FFFFFF,shadow:true,rx:8,ry:8;
    classDef ext fill:#0D9488,stroke:#0F766E,stroke-width:2px,color:#FFFFFF,rx:6,ry:6;
    classDef runtime fill:#4B5563,stroke:#374151,stroke-width:1px,color:#F3F4F6,stroke-dasharray: 4 4;

    %% --- 1. User Interaction (用户交互与接口层) ---
    subgraph UserInteraction ["👤 User & Interface Layer"]
        direction TB
        User1(["👨‍💻 Developer (CLI)"])
        User2(["🤖 AI Agent (MCP)"])
        CLI_Entry["🖥️ CLI Entry<br/>(cac: index/search/tune)"]:::entry
        MCP_Server["🔌 MCP Server<br/>(codebase-retrieval)"]:::entry
        
        User1 --> CLI_Entry
        User2 --> MCP_Server
    end

    %% --- 2. Core Orchestration (核心流程编排) ---
    subgraph CoreOrchestration ["🧠 Core Orchestration"]
        direction TB
        IndexerController["⚙️ Indexer (Self-Healing)<br/>Hash Change Detection"]:::core
        SearchController["🔍 SearchService<br/>Retrieval Pipeline Manager"]:::core
    end

    CLI_Entry -->|"index"| IndexerController
    CLI_Entry -->|"search"| SearchController
    MCP_Server -->|"1. auto-index"| IndexerController
    MCP_Server -->|"2. query"| SearchController

    %% --- 3. Indexing Pipeline (索引构建流水线) ---
    subgraph IndexingPipeline ["📥 Indexing Pipeline (Scanner & Chunking)"]
        direction TB
        Crawler["🕷️ Crawler<br/>(fdir, .gitignore aware)"]:::pipeline
        Filter["🛡️ Filter<br/>(Ext Whitelist, Patterns)"]:::pipeline
        Processor["⏱️ Processor<br/>(xxhash file diffing)"]:::pipeline
        
        Splitter["🔪 SemanticSplitter<br/>(AST Dual-Text, Gap-Aware)"]:::logic
        Runtimes["🧩 Language Runtimes<br/>(TS, Java, Rust, Kotlin, Builtin Ts25)"]:::runtime
        
        Crawler --> Filter --> Processor --> Splitter
        Runtimes -.->|"Tree-Sitter Parsers"| Splitter
    end

    IndexerController ==>|"Start Scan"| Crawler
    Splitter ==>|"Yield Chunks"| IndexerController

    %% --- 4. Storage (本地数据存储层) ---
    subgraph DataStorage ["💾 Local Storage Layer"]
        direction TB
        LanceDB[("📊 VectorStore<br/>(LanceDB)<br/>Partitioned by ProjectId")]:::storage
        SQLite[("🗂️ Database<br/>(SQLite)<br/>FTS5 + Metadata")]:::storage
    end

    IndexerController ==>|"Upsert / Delete<br/>(Monotonic Updates)"| LanceDB & SQLite

    %% --- 5. Retrieval Pipeline (检索分析流水线) ---
    subgraph RetrievalPipeline ["📤 Retrieval Pipeline (Search & Pack)"]
        direction TB
        Recall["🎯 Dual Recall<br/>(Vector + SQLite FTS5)"]:::pipeline
        RRF["⚖️ RRF Fusion<br/>(Reciprocal Rank Fusion)"]:::pipeline
        Reranker["🧠 Rerank & Smart TopK<br/>(Anchor, Floor, Delta Guard)"]:::logic
        
        Expander["🕸️ GraphExpander<br/>(Contextual Graph Expansion)"]:::logic
        E1["E1: Neighbors (Spatial)"]:::runtime
        E2["E2: Breadcrumb (Structure)"]:::runtime
        E3["E3: Imports (Dependency)"]:::runtime
        
        Packer["📦 ContextPacker<br/>(Token Budgeting & Merge)"]:::pipeline
        
        Recall --> RRF --> Reranker --> Expander --> Packer
        Expander -.-> E1 & E2 & E3
    end

    SearchController ==>|"Query"| Recall
    Packer ==>|"Final Ranked Chunks"| SearchController
    LanceDB & SQLite ==>|"Vector / Text Search"| Recall
    SQLite ==>|"Reverse Lookup Definitions"| E3

    %% --- 6. External APIs (外部服务接入) ---
    subgraph ExternalAPI ["🌐 External Services (Multi-Key Rotation)"]
        direction TB
        EmbedAPI["🔢 Embedding API<br/>(HTTP Client)"]:::ext
        RerankAPI["🏆 Reranker API<br/>(Cross-Encoder)"]:::ext
    end

    IndexerController -.->|"Embed chunks"| EmbedAPI
    Recall -.->|"Embed query"| EmbedAPI
    Reranker -.->|"Score (Query, Chunk)"| RerankAPI

    %% --- 布局对齐线 (不可见连线，用于强制上下瀑布流布局，避免左右铺开) ---
    CLI_Entry ~~~ IndexerController
    IndexerController ~~~ Crawler
    Splitter ~~~ LanceDB
    Packer ~~~ EmbedAPI
```

## 🔑 核心模块解析

### 1. **Scanner 智能增量扫描**
* 结合 `fdir` 和快速 `xxhash` 算法，在秒级对比文件的增、删、改。
* **自愈更新 (Self-healing)**：`Indexer` 使用“先插新后删旧”的单调更新策略，杜绝索引黑洞。

### 2. **Semantic Splitter 语义分块**
* 基于 Tree-sitter 可插拔架构实现代码解析。
* 创新的 **Dual-Text** 与 **Gap-Aware** 机制确保分块既保证语义完整，又不丢失中间状态。

### 3. **Smart TopK 截断控制**
位于 Rerank 层与扩展层之间，为抵御劣质 Chunk 刷屏提供了多重防线：
* **Anchor & Floor**: 设定双下限（下限基准 + 比率门槛）。
* **Delta Guard**: 避免最高分与后续分数的异常断层。
* **Safe Harbor / Hard Cap**: 提供安全港兜底以及最高 Token 总量熔断机制。

### 4. **GraphExpander 图扩展策略**
检索不仅限于单一切片，而是向外延伸出 3 个维度的附带上下文：
* `E1 邻居扩展`：代码物理位置上的相邻切片（上/下文）。
* `E2 面包屑补全`：逻辑前缀匹配补充（如类名/命名空间结构）。
* `E3 Import 依赖扩展`：跨文件的跨依赖定义解析。

> [!TIP]
> **日常排查与优化**
> 您可以使用 `coderecall doctor . --repair` 随时审计与自愈索引状态；或者使用 `coderecall tune <dataset>` 基于离线反馈数据自动调参，寻找最佳的 RRF/TopK 超参组合。
