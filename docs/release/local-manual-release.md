# ContextWeaver 本地手动发版操作手册

> 适用场景：在本地机器手动发布 `@alistar.max/contextweaver` 及语言插件包。

## 1. 发布前准备

### 1.1 环境要求

- Node.js：建议 `22.x` 或 `24.x`
- 包管理：`pnpm >= 10`
- npm 登录状态：`npm whoami` 能正常返回用户名
- 当前分支代码已同步、无未预期改动

### 1.2 关键说明（provenance）

- 本地机器一般**不支持** OIDC provenance，脚本默认会自动关闭 provenance。
- 若在支持 OIDC 的 CI（如 GitHub Actions）执行，脚本会自动开启 provenance。
- 可手动覆盖：
  - 强制开启：`--provenance`
  - 强制关闭：`--no-provenance`

## 2. 版本统一

> 发布前必须把主包和所有插件包的 `version` 统一为目标版本。

建议检查：

```bash
node - <<'NODE'
const fs = require('fs');
const path = require('path');
const root = process.cwd();
const files = [
  'package.json',
  ...fs.readdirSync(path.join(root, 'packages')).map((d) => `packages/${d}/package.json`),
];
for (const rel of files) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
  console.log(`${rel}: ${pkg.version}`);
}
NODE
```

## 3. 发布前校验（必须）

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm -r build
```

> 若有网络依赖（如 MCP E2E 依赖外部 Embedding API），请按实际网络情况单独评估。

## 4. 插件包发布（推荐走脚本）

仓库已内置脚本：`scripts/publish-plugins.sh`

### 4.1 Dry-run 演练

```bash
bash scripts/publish-plugins.sh --version 0.0.8 --dry-run
```

### 4.2 正式发布

```bash
bash scripts/publish-plugins.sh --version 0.0.8
```

### 4.3 常用参数

- `--version <x.y.z>`：要求所有插件包版本必须与该版本一致
- `--tag <tag>`：发布到指定 dist-tag（默认 `latest`）
- `--dry-run`：演练，不真正发布
- `--provenance`：强制附带 provenance（仅 OIDC 环境可用）
- `--no-provenance`：禁用 provenance

### 4.4 脚本发布顺序

1. 单语言插件：`lang-typescript`、`lang-kotlin`、`lang-csharp`、`lang-cpp`、`lang-java`、`lang-ruby`、`lang-c`、`lang-php`、`lang-rust`、`lang-swift`
2. 聚合插件：`lang-all`
3. 兼容插件：`lang-ts21`、`lang-ts22`

## 5. 主包发布（手动）

插件发布完成后，发布主包：

```bash
npm publish --access public --no-git-checks
```

如果你在 OIDC CI 环境发布主包，可附带：

```bash
npm publish --access public --no-git-checks --provenance
```

## 6. 发布后核验

### 6.1 检查 npm registry

```bash
npm view @alistar.max/contextweaver@0.0.8 version
npm view @alistar.max/contextweaver-lang-all@0.0.8 version
npm view @alistar.max/contextweaver-lang-typescript@0.0.8 version
npm view @alistar.max/contextweaver-lang-rust@0.0.8 version
```

### 6.2 本地安装冒烟

```bash
TMP_DIR="$(mktemp -d)"
cd "$TMP_DIR"
npm init -y
npm i @alistar.max/contextweaver@0.0.8
npm i @alistar.max/contextweaver-lang-all@0.0.8
npx contextweaver --version
```

## 7. 常见问题

### Q1：报错 `Automatic provenance generation not supported for provider: null`

原因：本地环境没有 OIDC Provider，却传了 `--provenance`。

处理：

- 本地发布请不要强制 provenance（用默认 auto 或 `--no-provenance`）
- 或在 GitHub Actions 这类 OIDC 环境发布

### Q2：某些插件已发布，脚本中断怎么办？

直接重跑同一命令即可。脚本会自动跳过 npm 上已存在的同版本包。

### Q3：如何避免把本地 `.tgz` 打包进 npm 包？

各插件包已经使用 `files` 白名单，仅发布 `dist/**/*.js` 与 `dist/**/*.d.ts`。
