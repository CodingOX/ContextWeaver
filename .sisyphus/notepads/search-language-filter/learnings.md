# Learnings & Conventions

> 累积发现的代码风格、架构约定、最佳实践

## Task 1: 语言分类常量实现

### 实现要点
- 新增 `LANGUAGE_CATEGORIES` 导出常量，采用 `as const` 确保类型安全
- 分类规则：code(26种) / docs(1种) / config(4种)
- `isKnownLanguage()` 复用现有 `ALLOWED_LANGUAGES` Set，保证白名单一致性
- 遵循现有代码风格：公共 API 使用 JSDoc 简体中文注释

### 技术细节
- `LANGUAGE_CATEGORIES.code` 包含所有代码类语言，排除 markdown/json/yaml/toml/xml
- `getCodeLanguages()` 返回 code 数组副本（避免外部修改）
- 编译验证通过：ESM build 29ms，DTS build 974ms

### 后续任务依赖
- 本任务完成后解除 Task 2, 5, 7 的阻塞
