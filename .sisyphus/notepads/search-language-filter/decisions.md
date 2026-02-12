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

