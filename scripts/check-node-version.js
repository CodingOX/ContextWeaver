#!/usr/bin/env node

/**
 * 安装前硬守卫：
 * - tree-sitter@0.25 在当前发布链路下无法稳定支持 Node 24 安装期编译
 * - 在进入 node-gyp 失败之前，直接给出明确错误与建议版本
 */

const rawVersion =
  process.env.CONTEXTWEAVER_NODE_VERSION_OVERRIDE || process.version;

const match = /^v(\d+)\./.exec(rawVersion);
const major = match ? Number(match[1]) : Number.NaN;

if (!Number.isFinite(major)) {
  console.error(`[ContextWeaver] 无法识别当前 Node 版本：${rawVersion}`);
  process.exit(1);
}

if (major >= 24) {
  console.error(
    [
      '[ContextWeaver] 当前暂不支持 Node 24 及以上版本安装。',
      `检测到版本：${rawVersion}`,
      '原因：tree-sitter 原生模块在该安装链路下会触发本地编译失败。',
      '建议：请切换到 Node 22 LTS 后重新安装。',
    ].join('\n'),
  );
  process.exit(1);
}
