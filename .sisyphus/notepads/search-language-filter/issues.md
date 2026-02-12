# Issues & Gotchas

> 遇到的问题、陷阱、边界情况


## Task 2: 边界情况与潜在问题

### 已处理的边界情况

1. **参数冲突检测顺序**
   - 先检测 `source_code_only + include_languages` 互斥
   - 再检测 `include/exclude` 交集
   - 最后校验白名单（两次调用 `validateLanguageWhitelist`）

2. **空数组输入**
   - `include_languages: []` 等价于未传参
   - `exclude_languages: []` 不影响归一化结果

3. **仅黑名单场景**
   - 归一化返回 `undefined`，由 SearchService 反向过滤
   - 避免在 MCP 层预计算全量白名单（保持灵活性）

### 潜在待确认问题

1. **`unknown` 语言的语义**
   - 当前允许用户显式传 `include_languages: ['unknown']`
   - 需确认 SearchService 是否支持按 `unknown` 过滤

2. **大小写敏感性**
   - 当前白名单校验区分大小写（`typescript` vs `TypeScript`）
   - 需确认 LLM 生成参数时是否严格遵循小写约定

3. **性能考虑**
   - `source_code_only` 归一化为 26 个语言数组
   - 若 SearchService 使用 `languageFilter.includes(lang)` 判断，建议转为 Set

## Task 2: 代码质量待优化

**未使用的导入** (技术债)
- `isKnownLanguage` 已导入但未使用（L17）
- `validateLanguageWhitelist` 手动创建 Set 而非复用辅助函数
- 建议优化：`lang !== 'unknown' && !isKnownLanguage(lang)`
- 状态：非阻塞，逻辑正确，可后续优化

