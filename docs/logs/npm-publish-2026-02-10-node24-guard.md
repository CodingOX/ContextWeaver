# npm 发布日志（2026-02-10）

## 变更目标

本次发布的核心目标是：为 **Node 24** 增加安装阶段保护（install guard），并在拦截时提供清晰、友好的中文提示，避免用户在不受支持的 Node 版本下进入原生模块编译失败流程。

## 关键改动

1. `package.json`
   - `engines.node` 调整为 `>=20 <24`
   - 新增 `preinstall` 脚本：`node scripts/check-node-version.js`
   - `files` 增加 `scripts/check-node-version.js`，确保发布包内包含安装检查脚本

2. `scripts/check-node-version.js`
   - 新增 Node 主版本检查逻辑
   - 当检测到 `Node 24+` 时直接拦截安装并返回非 0 退出码
   - 输出中文友好提示，明确建议切换到 Node 22 LTS

3. `README.md`
   - 环境要求更新为：`Node.js >= 20 且 < 24（推荐 Node.js 22 LTS）`

## 验证命令与结果

### 1) Node 22 通过

```bash
node -v
node scripts/check-node-version.js
```

结果：检查通过，退出码为 0。

### 2) Node 24 拦截

```bash
npx -y node@24.11.1 scripts/check-node-version.js
```

结果：脚本按预期拦截，输出提示并返回非 0 退出码。

### 3) 单元测试通过

```bash
pnpm test
```

结果：测试通过。

### 4) npm 打包 dry-run 包含脚本

```bash
npm pack --dry-run
```

结果：打包清单中包含 `scripts/check-node-version.js`，守卫逻辑可随包发布。

## 发布后验证命令

```bash
# 1) 查看线上版本与标签
npm view @alistar.max/contextweaver version dist-tags --json

# 2) 在 Node 22 环境验证可安装
nvm use 22
npm i -g @alistar.max/contextweaver@latest
contextweaver --version

# 3) 在 Node 24 环境验证被拦截（预期失败并提示）
nvm use 24
npm i -g @alistar.max/contextweaver@latest
```

预期：Node 22 安装成功并可执行；Node 24 安装阶段被守卫拦截且提示明确。
