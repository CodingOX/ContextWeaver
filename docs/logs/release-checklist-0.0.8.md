# ContextWeaver 0.0.8 发布可执行清单

> 目标版本：`0.0.8`
>
> npm 包名：`@alistar.max/contextweaver`
>
> 可选插件：`@alistar.max/contextweaver-lang-ts21`、`@alistar.max/contextweaver-lang-ts22`
>
> Node 版本约束：`>=20 <25`（含 Node 24）

## 阶段一：发布前

- [ ] 检查工作区状态：`git status --short`
- [ ] 校验待发布版本：`node -p "require('./package.json').version"`（期望 `0.0.8`）
- [ ] 校验 engines 约束：`node -p "require('./package.json').engines.node"`（期望 `>=20 <25`）
- [ ] 切换发布环境（推荐 Node 22 LTS）：`nvm install 22 && nvm use 22 && node -v`
- [ ] 安装依赖：`pnpm install --frozen-lockfile`
- [ ] 运行测试（单次执行建议控制在 60s 内）：`pnpm test`
- [ ] 构建全部包：`pnpm -r build`
- [ ] 检查打包文件：`npm pack --dry-run`
- [ ] 校验 npm 登录态：`npm whoami`
- [ ] 验证 Node24 冒烟：

  ```bash
  nvm install 24
  nvm use 24
  pnpm build
  pnpm test:install:node24
  ```

## 阶段二：发布时（插件优先）

- [ ] 最终确认 Node 版本：`node -v`（建议 `v22.x`）
- [ ] 发布 `@alistar.max/contextweaver-lang-ts21`

  ```bash
  cd packages/lang-ts21
  npm publish --access public
  cd -
  ```

- [ ] 发布 `@alistar.max/contextweaver-lang-ts22`

  ```bash
  cd packages/lang-ts22
  npm publish --access public
  cd -
  ```

- [ ] 发布主包 `@alistar.max/contextweaver`

  ```bash
  npm publish --access public
  ```

- [ ] 发布结果校验：

  ```bash
  npm view @alistar.max/contextweaver version
  npm view @alistar.max/contextweaver-lang-ts21 version
  npm view @alistar.max/contextweaver-lang-ts22 version
  ```

## 阶段三：发布后回归

- [ ] Node 22 冒烟：`nvm use 22 && npx -y @alistar.max/contextweaver@0.0.8 --help`
- [ ] Node 20 冒烟：`nvm install 20 && nvm use 20 && npx -y @alistar.max/contextweaver@0.0.8 --help`
- [ ] Node 24 冒烟：`nvm use 24 && npx -y @alistar.max/contextweaver@0.0.8 --help`
- [ ] 插件安装验证：

  ```bash
  npm i -g @alistar.max/contextweaver-lang-ts21@0.0.8
  npm i -g @alistar.max/contextweaver-lang-ts22@0.0.8
  ```

- [ ] 检查安装日志中无 `tree-sitter` peer 冲突 warn

## 回滚 / 补救建议

- [ ] 发布失败（网络/认证/OTP）：修复后重试

  ```bash
  npm whoami
  npm publish --access public
  ```

- [ ] 如主包已发布但插件缺失：先补发插件包，再更新 README 说明

- [ ] 如线上出现严重兼容问题：

  ```bash
  npm dist-tag add @alistar.max/contextweaver@0.0.7 latest
  npm deprecate @alistar.max/contextweaver@0.0.8 "0.0.8 存在问题，请回退到 0.0.7"
  ```
