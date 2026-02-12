# Architectural Decisions

> 关键技术选型与设计决策记录


## Task 3: BuildContextPackOptions 接口扩展

**时间**: 2026-02-12  
**文件**: `src/search/types.ts:100-105`

### 实现决策

1. **字段定义**
   - 新增 `languageFilter?: string[]` 可选字段
   - 与 `filePathFilter` 并列，支持独立或组合使用
   - 空数组/undefined 语义：不进行语言过滤

2. **注释风格**
   - 遵循项目约定：简体中文 JSDoc
   - 明确空值行为，避免调用方歧义

3. **类型兼容性**
   - 接口扩展向后兼容（可选字段）
   - SearchService 和 MCP 工具可无缝引用

### 验证通过

- ✅ `pnpm build` 编译成功
- ✅ TypeScript 类型检查无错误
- ✅ 下游调用链类型推导正常


## Task 2: MCP 参数扩展与校验逻辑

### 设计决策

**参数设计**
- 新增 3 个可选参数：`source_code_only`, `include_languages`, `exclude_languages`
- 互斥关系：`source_code_only` 与 `include_languages` 不可同时使用
- 允许组合：`source_code_only + exclude_languages` 可叠加（先取代码语言，再排除）

**校验策略**
- 早失败原则：参数解构后立即执行校验（先冲突检测，后白名单校验）
- 白名单来源：`getAllowedLanguages() + 'unknown'`（31 种语言 + 未知扩展名）
- 错误消息格式：清晰可定位，包含冲突的具体参数名和值

**归一化规则**
- `source_code_only: true` → 转换为 `getCodeLanguages()`（26 种代码语言）
- `include_languages` → 直接使用白名单数组
- 仅 `exclude_languages` → 返回 `undefined`（SearchService 层反向过滤）
- 黑名单叠加：最终结果 = 白名单 - `exclude_languages`

**传递路径**
- 归一化为统一的 `languageFilter: string[] | undefined`
- 通过 `BuildContextPackOptions` 传递给 `SearchService.buildContextPack()`
- 日志记录：在 MCP 调用开始和查询构建阶段记录 `languageFilter`

### 实现细节

**函数职责分离**
- `validateLanguageFilterConflicts()` - 专注冲突检测
- `validateLanguageWhitelist()` - 专注白名单校验
- `normalizeLanguageFilter()` - 专注归一化逻辑

**参考现有模式**
- 归一化风格参照 `pathFilter.ts` 的 `normalizeFilePathFilterConfig()`
- JSDoc 风格遵循项目简体中文注释约定
- 日志结构与现有 `includeGlobs/excludeGlobs` 保持一致

### 边界情况处理

1. **空数组输入**
   - `include_languages: []` 等价于未传参（归一化时过滤）
   - `exclude_languages: []` 不触发黑名单逻辑

2. **未知语言值**
   - 在白名单校验阶段抛出错误，阻止无效参数传递到 SearchService

3. **仅黑名单场景**
   - 返回 `undefined`，由 SearchService 在候选结果中反向过滤

### 后续任务依赖

- 本任务完成后解除 Task 4（SearchService 实现）和 Task 7（集成测试）的阻塞
