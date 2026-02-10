import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  CORE_PLUGIN_CANDIDATES,
  DEFAULT_PLUGIN_CANDIDATES,
  LEGACY_PLUGIN_CANDIDATES,
  discoverPluginPackages,
} from '../../src/chunking/runtime/PluginLoader.js';

test('默认插件候选顺序应为 all → 单语言 → legacy', () => {
  assert.equal(DEFAULT_PLUGIN_CANDIDATES[0], '@alistar.max/contextweaver-lang-all');
  assert.deepEqual(
    DEFAULT_PLUGIN_CANDIDATES.slice(0, CORE_PLUGIN_CANDIDATES.length),
    CORE_PLUGIN_CANDIDATES,
  );
  assert.deepEqual(
    DEFAULT_PLUGIN_CANDIDATES.slice(DEFAULT_PLUGIN_CANDIDATES.length - LEGACY_PLUGIN_CANDIDATES.length),
    LEGACY_PLUGIN_CANDIDATES,
  );
});

test('应能发现有效插件 runtime', async () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-plugin-loader-valid-'));

  try {
    const validPluginPath = path.join(fixtureDir, 'valid-plugin.mjs');
    fs.writeFileSync(
      validPluginPath,
      [
        'export function createRuntime() {',
        '  return {',
        "    id: 'plugin-valid-fixture',",
        "    languages: ['kotlin'],",
        '    canParse(language) { return language === "kotlin"; },',
        '    async getParser() { return null; },',
        '  };',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    const validWarns: string[] = [];
    const discovered = await discoverPluginPackages([pathToFileURL(validPluginPath).href], {
      logger: {
        warn: (...args) => {
          validWarns.push(args.map((arg) => String(arg)).join(' '));
        },
      },
    });

    assert.equal(discovered.length, 1, '应能发现有效插件 runtime');
    assert.equal(discovered[0]?.id, 'plugin-valid-fixture');
    assert.equal(discovered[0]?.canParse('kotlin'), true, '发现的 runtime 应支持 kotlin');
    assert.deepEqual(validWarns, [], '有效插件不应输出 warn');
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('缺失插件包时应返回空数组并记录 warn', async () => {
  const missingWarns: string[] = [];
  const missing = await discoverPluginPackages(['@alistar.max/contextweaver-lang-missing'], {
    logger: {
      warn: (...args) => {
        missingWarns.push(args.map((arg) => String(arg)).join(' '));
      },
    },
  });

  assert.deepEqual(missing, [], '缺失插件包时应返回空数组');
  assert.equal(missingWarns.length > 0, true, '缺失插件包时应输出 warn');
});

test('suppressMissingModuleError=true 时应忽略缺失模块警告', async () => {
  const missingWarns: string[] = [];
  const missing = await discoverPluginPackages(['@alistar.max/contextweaver-lang-missing'], {
    suppressMissingModuleError: true,
    logger: {
      warn: (...args) => {
        missingWarns.push(args.map((arg) => String(arg)).join(' '));
      },
    },
  });

  assert.deepEqual(missing, [], '缺失插件包时应返回空数组');
  assert.deepEqual(missingWarns, [], '启用 suppressMissingModuleError 时不应输出 warn');
});

test('createRuntime 缺失或非法时应被忽略', async () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-plugin-loader-invalid-'));

  try {
    const noFactoryPath = path.join(fixtureDir, 'no-factory.mjs');
    const invalidFactoryPath = path.join(fixtureDir, 'invalid-factory.mjs');

    fs.writeFileSync(noFactoryPath, 'export const noop = true;\n', 'utf8');
    fs.writeFileSync(
      invalidFactoryPath,
      [
        'export function createRuntime() {',
        "  return { id: 123, languages: ['kotlin'], canParse: () => true };",
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    const invalidWarns: string[] = [];
    const invalid = await discoverPluginPackages(
      [pathToFileURL(noFactoryPath).href, pathToFileURL(invalidFactoryPath).href],
      {
        logger: {
          warn: (...args) => {
            invalidWarns.push(args.map((arg) => String(arg)).join(' '));
          },
        },
      },
    );

    assert.deepEqual(invalid, [], 'createRuntime 缺失或非法时应被忽略');
    assert.equal(invalidWarns.length >= 2, true, '非法插件应输出 warn');
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});
