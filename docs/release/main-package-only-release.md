# ContextWeaver 主包单独发版手册

> 适用场景：本次改动仅涉及主包 `@alistar.max/contextweaver`，插件包无需发版。

## 1. 什么时候用这个流程

满足以下条件时，使用本手册：

- 只改了主包代码（如 `src/**`、主包脚本、主包文档）
- `packages/lang-*` 插件代码和构建产物没有功能变化
- 不需要对外发布新的插件版本

## 2. 发版前检查

### 2.1 环境检查

```bash
node -v
pnpm -v
npm whoami
```

### 2.2 工作区检查

```bash
git status
```

要求：工作区干净，或只包含本次发版相关改动。

### 2.3 版本检查

确认主包版本已更新到目标版本：

```bash
node -p "require('./package.json').version"
```

## 3. 发布前验证（建议全量）

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm build
```

## 4. 仅发布主包

在仓库根目录执行：

```bash
npm publish --access public --no-git-checks
```

如果在支持 OIDC 的 CI 环境发布，可带 provenance：

```bash
npm publish --access public --no-git-checks --provenance
```

## 5. 发布后验证

### 5.1 Registry 校验

将 `0.0.9` 替换为目标版本：

```bash
npm view @alistar.max/contextweaver@0.0.9 version
```

### 5.2 安装冒烟

```bash
TMP_DIR="$(mktemp -d)"
cd "$TMP_DIR"
npm init -y
npm i @alistar.max/contextweaver@0.0.9
npx contextweaver --version
```

## 6. 和插件发布脚本的关系

- 本流程**不需要**执行 `scripts/publish-plugins.sh`。
- 如果你误用了插件脚本并传了 `--version`，插件版本不一致会触发校验。
- 若你只是想“跳过插件并继续流程”，可显式加：

```bash
bash scripts/publish-plugins.sh --version 0.0.9 --allow-version-mismatch --dry-run
```

这会跳过版本不一致的插件包，不会阻断流程。
