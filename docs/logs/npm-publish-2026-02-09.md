# npm 发布日志（2026-02-09）

## 变更目标

- 将 npm 包归属切换为 `@alistar.max/contextweaver`
- 更新 README 安装命令为新包名
- 尝试发布到 npm 官方仓库

## 关键改动

- `package.json`
  - `name`: `@alistar.max/contextweaver`
  - `author`: `alistar.max`
  - `repository/homepage`: 指向 `CodingOX/ContextWeaver`
  - `publishConfig.access`: `public`
  - `scripts`
    - `build/dev/build:release` 仅构建 `src/index.ts`
    - 新增 `prepublishOnly` 与 `prepack`
- `README.md`
  - 安装命令更新为 `@alistar.max/contextweaver`

## 发布前校验

1. `pnpm test`：通过
2. `pnpm build`：通过
3. `npm pack --dry-run`：通过（产物内容正常）

## 发布尝试结果

- 执行命令：`npm publish --access public`
- 认证状态：`npm whoami` 返回 `alistar.max`
- 失败原因：`EOTP`
- 错误摘要：当前账号启用了发布二次验证，需要在发布命令中附带一次性验证码（OTP）

## 后续操作

使用有效 OTP 再次执行：

```bash
npm publish --access public --otp <6位动态码>
```

发布成功后可验证：

```bash
npm view @alistar.max/contextweaver version
```
