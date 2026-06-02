# VectorStore/Indexer 缓存上限与锁实现重构设计

## 1. 背景

CodeRecall 当前已经补齐了单次检索结束后的主动释放能力：

- `SearchService.close()` 会清理当前项目的 `VectorStore`、`Indexer`、`GraphExpander`
- `scanner/index.ts` 的 `finally` 会执行全量 `closeAllIndexers()` / `closeAllVectorStores()`
- `GraphExpander` 也已经补上显式 `close()`

但这还没有彻底解决两个更底层的问题：

1. 模块级缓存 `vectorStores` / `indexers` 没有容量上限
2. `lock.ts` 仍然是“文件存在 + 失效清理 + 自旋重试”的手写锁实现

这两个点都不是“今天就会必炸”的 blocker，但它们已经进入“值得单独设计和治理”的阶段。

---

## 2. 当前实现现状

### 2.1 缓存工厂现状

`VectorStore` 和 `Indexer` 都是按 `projectId` 做模块级单例缓存：

- `vectorStore/index.ts:L407-L440`
- `indexer/index.ts:L528-L557`

当前行为：

- 首次访问某个 `projectId` 时创建实例并放入 `Map`
- 业务方需要显式调用 `closeVectorStore(projectId)` / `closeIndexer(projectId)` 清理
- 也提供 `closeAll...()` 兜底

问题在于：

- `Map` 没有容量上限
- 没有最近使用时间或引用状态
- 没有自动淘汰
- 长驻 MCP 进程如果服务很多不同仓库，缓存会随项目数单调增长

`VectorStore` 风险更高，因为它持有底层 LanceDB / table 连接；`Indexer` 虽然没有显式 native close，但也会长期占据内存和配置状态。

### 2.2 锁实现现状

当前锁位于 `lock.ts:L1-L208`，核心流程是：

1. `writeFileSync(..., { flag: 'wx' })` 原子创建锁文件
2. 如果已存在，则读取 `index.lock`
3. 判断 `pid` 是否存活
4. 若认为失效，则 `unlinkSync()` 删除旧锁
5. 轮询重试，直到超时

已有回归测试：

- `lock-regression.test.ts:L16-L35`
- `lock-regression.test.ts:L37-L66`

当前实现已经覆盖了两个重要语义：

- 死锁进程留下的陈旧锁可以被回收
- 并发竞争下，后来的请求会在超时内失败，而不是直接闯入

但它仍然有两个结构性限制：

- “判断失效 -> 删除 -> 重试” 是多步流程，不是完整租约模型
- 锁文件只记录 `pid/timestamp/operation`，没有 owner token、epoch、续租、fencing 等更强语义

---

## 3. 为什么值得单独重构

### 3.1 缓存上限问题的本质

这个问题本质上不是“有没有 close”，而是“生命周期控制是不是只靠调用方自觉”。

现在的设计默认：

- 每条调用链都会正确 close
- 异常路径不会漏
- 同一进程服务的项目数量有限

这三个假设在 CLI 场景大体成立，但在 MCP 长驻场景里都偏乐观。

一旦出现以下情况，缓存会积累：

- 调用链异常中断，没走到 close
- 新增调用点忘记补 close
- 单个 MCP 进程持续服务大量 repo
- 将来增加后台任务或预热流程，生命周期变复杂

### 3.2 锁问题的本质

这个问题本质上不是“`wx` 不原子”，而是“当前锁只是排他文件，不是完整的 ownership protocol”。

`wx` 已经保证“创建锁文件”本身是原子的，所以现在并不是完全失控。

真正的问题是：

- 失效判断依赖 `pid`
- stale lock 清理和 ownership 交接没有 fencing token
- 没有 lease / renew 机制
- 没有 owner identity beyond pid
- 多进程 / 多 agent / 长操作场景下，可观测性不足

换句话说，当前实现更像“够用的本地互斥”，还不是“工程级索引协调机制”。

---

## 4. 建议的设计改动

### 4.1 缓存层：从无界 Map 改为有界资源池

建议把 `vectorStores` / `indexers` 从“裸 `Map`”升级为“有界缓存池”。

目标语义：

- 保留按 `projectId` 复用实例的优点
- 增加容量上限，例如 `maxEntries = 32` 或 `50`
- 记录最近访问时间
- 超限时优先淘汰最近最少使用（LRU）且当前空闲的实例
- 被淘汰时执行真实资源释放

建议抽象：

- 新增统一的 `ProjectResourceCache<T>`
- `get(projectId)` 时更新访问时间
- `set(projectId, resource)` 后检查是否超限
- `evict()` 时调用资源自己的 `close()` 或 `dispose()`

如果不想一开始就抽象公共类，也可以先分别在 `VectorStore` / `Indexer` 工厂里做同构实现。

### 4.2 锁层：从文件排他锁升级为租约锁模型

建议目标不是“换个 npm 包就结束”，而是把锁语义提升成租约（lease）模型。

建议最小模型：

- 锁记录：
  - `ownerId`
  - `pid`
  - `operation`
  - `acquiredAt`
  - `expiresAt`
  - `generation`
- 获取锁：
  - 原子创建
  - 若存在则检查是否过期
  - 过期回收时必须带 generation / fencing 语义
- 持锁执行：
  - 长任务可续租
- 释放锁：
  - 只有 ownerId + generation 匹配时才能释放

如果短期不引入完整续租机制，至少也应该补：

- owner token
- lease timeout
- generation/fencing
- 更清晰的错误分类和日志

---

## 5. 涉及到的“状态机 / 生命周期”改动

这里没有业务状态机，但有两个很关键的资源生命周期状态机。

### 5.1 缓存资源生命周期

当前大致是：

```text
未创建
  -> 首次访问
已创建/已缓存
  -> 显式 close
已释放
```

建议改成：

```text
未创建
  -> 首次访问
已创建/活跃
  -> 一段时间未访问
已空闲
  -> 容量超限触发淘汰
已释放

已空闲
  -> 再次访问
已创建/活跃
```

关键变化：

- “是否释放”不再只依赖调用方
- 缓存层自己具备回收决策能力

### 5.2 锁生命周期

当前大致是：

```text
无锁
  -> wx 创建成功
持锁
  -> 正常释放
无锁

持锁
  -> 进程死亡 / 文件损坏
疑似失效锁
  -> 其他进程 unlink
无锁
```

建议改成：

```text
无锁
  -> acquire
已租约
  -> heartbeat/renew
已租约
  -> release
无锁

已租约
  -> 超时未续租
已过期
  -> 新 owner 抢占并提升 generation
新租约
```

关键变化：

- “锁是否有效”从 `pid 是否活着`，升级成“租约是否仍有效”
- “释放谁的锁”从 `pid 相同即可`，升级成“owner + generation 匹配”

---

## 6. 带来的优势

### 6.1 对缓存层

- 控制长驻进程的内存与连接数量上界
- 降低“忘记 close 导致缓慢泄漏”的风险
- 提高 MCP 多 repo 场景的稳定性
- 让资源治理从“调用方纪律”升级为“框架层机制”

### 6.2 对锁层

- 失效锁回收语义更清晰
- 长操作更容易支持 heartbeat / renew
- 降低 stale lock 被误判或误删的概率
- 为未来多 agent / 并发索引 / 后台维护任务打基础

---

## 7. 对现在造成的影响

### 7.1 当前如果不做，会怎样

短期内：

- 大多数 CLI 场景还能正常工作
- 现有 `withLock()` 也足以挡住最常见的并发写入

中长期：

- MCP 长驻进程更容易出现缓存累积
- repo 数量增长后，连接数和内存占用会变得不可预测
- 锁问题排查仍然依赖日志和偶发复现，不容易精准定位 ownership 问题

### 7.2 做了之后，会影响哪些行为

缓存上限改造后：

- 某个很久没访问的项目资源可能被自动回收
- 再次访问该项目时会重新初始化实例
- 首次命中可能比“永远缓存”多一次冷启动，但换来可控上界

锁重构后：

- 锁文件格式会变化
- 日志、错误文案、测试都要更新
- 可能需要给扫描/索引长任务预留续租或更长 lease 配置

---

## 8. 建议的实施顺序

### 阶段一：缓存上限

优先级更高，风险更低。

建议步骤：

1. 给 `VectorStore` 工厂加 LRU / 上限淘汰
2. 给 `Indexer` 工厂复用同样策略
3. 增加资源池测试：
   - 超限淘汰
   - 最近访问保活
   - 淘汰时调用 close/dispose

### 阶段二：锁实现重构

优先级次之，但设计要更完整。

建议步骤：

1. 先写锁语义文档和状态流
2. 明确是否要引入第三方锁库，还是保留自研
3. 新增 owner token / generation / expiresAt
4. 补并发与 stale lock 场景测试
5. 最后替换 `withLock()` 底层实现

---

## 9. 是否建议立即实施

结论：

- `vectorStores/indexers` 缓存上限：建议尽快做
- `lock.ts` 整体重构：建议单独立项，不建议和零碎 bugfix 混在一起

原因：

- 缓存上限是典型“低耦合、高收益”的治理项
- 锁重构会改变并发协调语义，应该单独设计、单独验证

---

## 10. 与当前已完成工作的关系

这份文档不是在推翻前面的修复，而是在它们之上继续补“机制层治理”：

- 我们已经补了 `SearchService.close()` / `GraphExpander.close()` 等显式释放
- 现在还差“即便调用方漏掉释放，也不会无限增长”的缓存治理
- 我们已经有基本锁回归测试
- 现在还差“锁 ownership 和 stale recovery 有完整协议”的并发治理

所以这两个主题适合作为下一轮独立工程项，而不是继续塞进当前的小修补回合。
