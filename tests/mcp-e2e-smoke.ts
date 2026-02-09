import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

interface CaseItem {
  name: string;
  informationRequest: string;
  technicalTerm: string;
  expectedFile: string;
}

const REQUIRED_ENV_KEYS = [
  'EMBEDDINGS_API_KEY',
  'EMBEDDINGS_BASE_URL',
  'EMBEDDINGS_MODEL',
  'RERANK_API_KEY',
  'RERANK_BASE_URL',
  'RERANK_MODEL',
] as const;

function parseEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    result[key] = value;
  }
  return result;
}

function hasAllRequired(config: Record<string, string>): boolean {
  return REQUIRED_ENV_KEYS.every((key) => {
    const value = config[key];
    return Boolean(value) && value !== 'your-api-key-here';
  });
}

async function loadRuntimeConfig(): Promise<Record<string, string> | null> {
  const envConfig: Record<string, string> = {};
  for (const key of REQUIRED_ENV_KEYS) {
    if (process.env[key]) {
      envConfig[key] = process.env[key] as string;
    }
  }

  if (hasAllRequired(envConfig)) {
    return envConfig;
  }

  const homeEnvPath = path.join(os.homedir(), '.contextweaver', '.env');
  try {
    const envText = await fs.readFile(homeEnvPath, 'utf-8');
    const fileConfig = parseEnv(envText);
    if (hasAllRequired(fileConfig)) {
      return fileConfig;
    }
  } catch {
    // ignore
  }

  return null;
}

async function createFixtureRepo(root: string): Promise<void> {
  const files: Array<{ relPath: string; content: string }> = [
    {
      relPath: 'php/PhpAuthGateway.php',
      content: `<?php
namespace Demo\\Auth;

final class PhpAuthGateway {
    public function signIn(string $email, string $password): bool {
        return $email !== '' && $password !== '';
    }
}
`,
    },
    {
      relPath: 'ruby/RubyBillingService.rb',
      content: `class RubyBillingService
  def charge_cents(amount)
    amount > 0
  end
end
`,
    },
    {
      relPath: 'swift/SwiftTokenProvider.swift',
      content: `import Foundation

final class SwiftTokenProvider {
    func issueToken(userId: String) -> String {
        return "token-\\(userId)"
    }
}
`,
    },
    {
      relPath: 'dart/dart_session_manager.dart',
      content: `class DartSessionManager {
  String createSession(String userId) {
    return 'session:$userId';
  }
}
`,
    },
    {
      relPath: 'csharp/CSharpPolicyEngine.cs',
      content: `namespace Demo.Auth;

public sealed class CSharpPolicyEngine
{
    public bool Evaluate(string role) => role == "admin";
}
`,
    },
  ];

  for (const file of files) {
    const absPath = path.join(root, file.relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, file.content, 'utf-8');
  }
}

async function runSearch(
  repoRoot: string,
  homeDir: string,
  item: CaseItem,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const args = [
      'dist/index.js',
      'search',
      '--repo-path',
      repoRoot,
      '--information-request',
      item.informationRequest,
      '--technical-terms',
      item.technicalTerm,
    ];

    const child = spawn('node', args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: homeDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`[${item.name}] 执行超时（60s）`));
    }, 60_000);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

async function main() {
  const runtimeConfig = await loadRuntimeConfig();
  if (!runtimeConfig) {
    console.log('⚠️ 跳过 MCP E2E：缺少可用 Embedding/Reranker 环境变量');
    process.exit(0);
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'contextweaver-mcp-e2e-'));
  const fakeHome = path.join(tempRoot, 'home');
  const fakeRepo = path.join(tempRoot, 'repo');
  const fakeConfigDir = path.join(fakeHome, '.contextweaver');

  await fs.mkdir(fakeConfigDir, { recursive: true });
  await fs.mkdir(fakeRepo, { recursive: true });
  await createFixtureRepo(fakeRepo);

  const envLines: string[] = [];
  for (const key of REQUIRED_ENV_KEYS) {
    envLines.push(`${key}=${runtimeConfig[key]}`);
  }
  if (runtimeConfig.EMBEDDINGS_DIMENSIONS) {
    envLines.push(`EMBEDDINGS_DIMENSIONS=${runtimeConfig.EMBEDDINGS_DIMENSIONS}`);
  }
  if (runtimeConfig.EMBEDDINGS_MAX_CONCURRENCY) {
    envLines.push(`EMBEDDINGS_MAX_CONCURRENCY=${runtimeConfig.EMBEDDINGS_MAX_CONCURRENCY}`);
  }
  if (runtimeConfig.RERANK_TOP_N) {
    envLines.push(`RERANK_TOP_N=${runtimeConfig.RERANK_TOP_N}`);
  }

  await fs.writeFile(path.join(fakeConfigDir, '.env'), `${envLines.join('\n')}\n`, 'utf-8');

  const cases: CaseItem[] = [
    {
      name: 'PHP',
      informationRequest: '请定位 PHP 登录网关实现',
      technicalTerm: 'PhpAuthGateway',
      expectedFile: 'php/PhpAuthGateway.php',
    },
    {
      name: 'Ruby',
      informationRequest: '请定位 Ruby 计费服务实现',
      technicalTerm: 'RubyBillingService',
      expectedFile: 'ruby/RubyBillingService.rb',
    },
    {
      name: 'Swift',
      informationRequest: '请定位 Swift Token 生成器实现',
      technicalTerm: 'SwiftTokenProvider',
      expectedFile: 'swift/SwiftTokenProvider.swift',
    },
    {
      name: 'Dart',
      informationRequest: '请定位 Dart 会话管理实现',
      technicalTerm: 'DartSessionManager',
      expectedFile: 'dart/dart_session_manager.dart',
    },
    {
      name: 'C#',
      informationRequest: '请定位 C# 策略引擎实现',
      technicalTerm: 'CSharpPolicyEngine',
      expectedFile: 'csharp/CSharpPolicyEngine.cs',
    },
  ];

  console.log(`🔍 开始 MCP E2E 回归，共 ${cases.length} 条用例`);

  for (const item of cases) {
    const result = await runSearch(fakeRepo, fakeHome, item);

    assert.equal(result.code, 0, `[${item.name}] CLI 退出码异常\n${result.stderr}`);
    assert.match(result.stdout, /Found\s+\d+\s+relevant\s+code\s+blocks/i, `[${item.name}] 无检索结果摘要`);
    assert.match(
      result.stdout,
      new RegExp(item.expectedFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `[${item.name}] 未命中期望文件 ${item.expectedFile}`,
    );

    console.log(`✅ ${item.name} E2E 通过`);
  }

  console.log('🎉 MCP E2E 多语言回归全部通过');
}

main().catch((err) => {
  console.error('❌ MCP E2E 回归失败');
  console.error(err);
  process.exit(1);
});
