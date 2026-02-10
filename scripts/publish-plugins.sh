#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

usage() {
  cat <<'USAGE'
批量发布 ContextWeaver 插件包（不发布主包）。

用法：
  scripts/publish-plugins.sh [选项]

选项：
  --version <x.y.z>   指定目标版本；若不传则使用各 package.json 的 version
  --tag <tag>         npm dist-tag（默认：latest）
  --dry-run           使用 npm publish --dry-run（仅演练）
  --provenance        强制附带 --provenance（需要支持 OIDC 的 CI 环境）
  --no-provenance     禁用 --provenance
  -h, --help          显示帮助

说明：
  1) 发布顺序：单语言包 -> lang-all -> 兼容包(ts21/ts22)
  2) 若 npm registry 已存在同名同版本，会自动跳过
  3) provenance 默认 auto：仅在支持 OIDC 的 CI 环境自动启用
USAGE
}

TARGET_VERSION=""
DIST_TAG="latest"
DRY_RUN="false"
PROVENANCE_MODE="auto"

is_oidc_supported() {
  [[ "${GITHUB_ACTIONS:-}" == "true" ]] &&
  [[ -n "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ]] &&
  [[ -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ]]
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      TARGET_VERSION="${2:-}"
      if [[ -z "$TARGET_VERSION" ]]; then
        echo "❌ --version 需要传入版本号，例如 0.0.8" >&2
        exit 1
      fi
      shift 2
      ;;
    --tag)
      DIST_TAG="${2:-}"
      if [[ -z "$DIST_TAG" ]]; then
        echo "❌ --tag 需要传入 tag 名称，例如 latest / next" >&2
        exit 1
      fi
      shift 2
      ;;
    --dry-run)
      DRY_RUN="true"
      shift
      ;;
    --provenance)
      PROVENANCE_MODE="true"
      shift
      ;;
    --no-provenance)
      PROVENANCE_MODE="false"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "❌ 未知参数: $1" >&2
      usage
      exit 1
      ;;
  esac
done

PLUGIN_DIRS=(
  "packages/lang-typescript"
  "packages/lang-kotlin"
  "packages/lang-csharp"
  "packages/lang-cpp"
  "packages/lang-java"
  "packages/lang-ruby"
  "packages/lang-c"
  "packages/lang-php"
  "packages/lang-rust"
  "packages/lang-swift"
  "packages/lang-all"
  "packages/lang-ts21"
  "packages/lang-ts22"
)

if ! command -v npm >/dev/null 2>&1; then
  echo "❌ 未找到 npm，请先安装 Node.js/npm" >&2
  exit 1
fi

cd "$ROOT_DIR"

USE_PROVENANCE="false"
if [[ "$PROVENANCE_MODE" == "true" ]]; then
  if ! is_oidc_supported; then
    echo "❌ 当前环境不支持 provenance（缺少 OIDC 上下文）。" >&2
    echo "   可改用 --no-provenance，或在支持 OIDC 的 CI 里运行。" >&2
    exit 1
  fi
  USE_PROVENANCE="true"
elif [[ "$PROVENANCE_MODE" == "auto" ]]; then
  if is_oidc_supported; then
    USE_PROVENANCE="true"
  fi
fi

echo "📦 开始批量发布插件"
echo "- 仓库目录: $ROOT_DIR"
echo "- dist-tag: $DIST_TAG"
echo "- dry-run: $DRY_RUN"
echo "- provenance(mode): $PROVENANCE_MODE"
echo "- provenance(enabled): $USE_PROVENANCE"
if [[ -n "$TARGET_VERSION" ]]; then
  echo "- 目标版本: $TARGET_VERSION"
fi

declare -i published=0
declare -i skipped=0

default_publish_flags=(--access public --no-git-checks --tag "$DIST_TAG")
if [[ "$USE_PROVENANCE" == "true" ]]; then
  default_publish_flags+=(--provenance)
fi
if [[ "$DRY_RUN" == "true" ]]; then
  default_publish_flags+=(--dry-run)
fi

for package_dir in "${PLUGIN_DIRS[@]}"; do
  package_json="$ROOT_DIR/$package_dir/package.json"

  if [[ ! -f "$package_json" ]]; then
    echo "⚠️ 跳过：未找到 $package_json"
    skipped+=1
    continue
  fi

  package_name="$(node -p "require('$package_json').name")"
  package_version="$(node -p "require('$package_json').version")"

  if [[ -n "$TARGET_VERSION" && "$package_version" != "$TARGET_VERSION" ]]; then
    echo "❌ 版本不一致：$package_name 当前为 ${package_version}，期望为 ${TARGET_VERSION}" >&2
    echo "   请先统一版本后再发布。" >&2
    exit 1
  fi

  publish_version="${TARGET_VERSION:-$package_version}"

  if npm view "$package_name@$publish_version" version >/dev/null 2>&1; then
    echo "⏭️  已存在，跳过：$package_name@$publish_version"
    skipped+=1
    continue
  fi

  echo "🚀 发布：$package_name@$publish_version"
  (
    cd "$ROOT_DIR/$package_dir"
    npm publish "${default_publish_flags[@]}"
  )
  published+=1
done

echo
echo "✅ 插件发布流程结束"
echo "- 发布成功: $published"
echo "- 跳过数量: $skipped"
