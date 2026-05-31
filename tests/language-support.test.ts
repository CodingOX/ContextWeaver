import assert from 'node:assert/strict';
import { getLanguage } from '../src/scanner/language.js';
import { isLanguageSupported } from '../src/chunking/ParserPool.js';
import { getLanguageSpec } from '../src/chunking/LanguageSpec.js';
import { CSharpResolver } from '../src/search/resolvers/CSharpResolver.js';
import { DartResolver } from '../src/search/resolvers/DartResolver.js';
import { PhpResolver } from '../src/search/resolvers/PhpResolver.js';
import { RubyResolver } from '../src/search/resolvers/RubyResolver.js';
import { SwiftResolver } from '../src/search/resolvers/SwiftResolver.js';

function test(name: string, fn: () => void | Promise<void>) {
  Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`✅ ${name}`);
    })
    .catch((err) => {
      console.error(`❌ ${name}`);
      console.error(err);
      process.exitCode = 1;
    });
}

test('语言映射包含 c_sharp 扩展名', () => {
  assert.equal(getLanguage('Foo.cs'), 'c_sharp');
  assert.equal(getLanguage('Foo.csx'), 'c_sharp');
});

test('内置语言已进入 AST 支持列表', () => {
  for (const lang of ['javascript', 'python', 'go']) {
    assert.equal(isLanguageSupported(lang), true, `语言 ${lang} 未注册到 ParserPool`);
  }
});

test('新增语言已配置 LanguageSpec', () => {
  for (const lang of ['php', 'ruby', 'swift', 'dart', 'c_sharp']) {
    const spec = getLanguageSpec(lang);
    assert.ok(spec, `语言 ${lang} 缺少 LanguageSpec`);
    assert.ok(spec?.hierarchy.size, `语言 ${lang} hierarchy 为空`);
  }
});

test('PhpResolver 支持 use/import 语句提取与解析', () => {
  const resolver = new PhpResolver();
  const content = `
use App\\Services\\UserService;
use App\\Repositories\\UserRepository as Repo;
use App\\Domain\\{OrderService, PaymentService as Pay};
use function App\\Utils\\formatName;
use const App\\Config\\DEFAULT_LIMIT;
`;

  const imports = resolver.extract(content);
  assert.deepEqual(imports, [
    'App\\Services\\UserService',
    'App\\Repositories\\UserRepository',
    'App\\Domain\\OrderService',
    'App\\Domain\\PaymentService',
    'App\\Utils\\formatName',
    'App\\Config\\DEFAULT_LIMIT',
  ]);

  const allFiles = new Set<string>([
    'src/App/Services/UserService.php',
    'src/App/Repositories/UserRepository.php',
    'src/App/Domain/OrderService.php',
    'src/App/Domain/PaymentService.php',
    'src/App/Utils/formatName.php',
    'src/App/Config/DEFAULT_LIMIT.php',
  ]);

  assert.equal(
    resolver.resolve('App\\Services\\UserService', 'src/App/Controllers/AuthController.php', allFiles),
    'src/App/Services/UserService.php',
  );
});

test('RubyResolver 支持 require/require_relative/autoload', () => {
  const resolver = new RubyResolver();
  const content = `
require 'rails/engine'
require_relative '../../lib/custom_loader'
autoload :UserService, 'services/user_service'
`;

  const imports = resolver.extract(content);
  assert.deepEqual(imports, [
    'require:rails/engine',
    'require_relative:../../lib/custom_loader',
    'autoload:services/user_service',
  ]);

  const allFiles = new Set<string>([
    'app/models/user.rb',
    'lib/custom_loader.rb',
    'services/user_service.rb',
    'vendor/rails/engine.rb',
  ]);

  assert.equal(
    resolver.resolve('require_relative:../../lib/custom_loader', 'app/models/user.rb', allFiles),
    'lib/custom_loader.rb',
  );
  assert.equal(
    resolver.resolve('autoload:services/user_service', 'app/models/user.rb', allFiles),
    'services/user_service.rb',
  );
});

test('SwiftResolver 支持 import 语句提取与解析', () => {
  const resolver = new SwiftResolver();
  const content = `
import Foundation
import struct ProjectCore.Logger
@testable import AppModule
`;

  assert.deepEqual(resolver.extract(content), ['Foundation', 'ProjectCore.Logger', 'AppModule']);

  const allFiles = new Set<string>([
    'Sources/Foundation.swift',
    'Sources/ProjectCore/Logger.swift',
    'Sources/AppModule/Feature.swift',
  ]);

  assert.equal(
    resolver.resolve('ProjectCore.Logger', 'Sources/AppModule/Feature.swift', allFiles),
    'Sources/ProjectCore/Logger.swift',
  );
  assert.equal(
    resolver.resolve('AppModule', 'Sources/AppModule/Feature.swift', allFiles),
    'Sources/AppModule/Feature.swift',
  );
});

test('DartResolver 支持相对 import/export/part 解析', () => {
  const resolver = new DartResolver();
  const content = `
import './models/user.dart';
export '../shared/helpers.dart';
part '../generated/user.g.dart';
part of './feature.dart';
`;

  assert.deepEqual(resolver.extract(content), [
    './models/user.dart',
    '../shared/helpers.dart',
    '../generated/user.g.dart',
    './feature.dart',
  ]);

  const allFiles = new Set<string>([
    'lib/features/models/user.dart',
    'lib/shared/helpers.dart',
    'lib/generated/user.g.dart',
    'lib/features/feature.dart',
  ]);

  assert.equal(
    resolver.resolve('./models/user.dart', 'lib/features/entry.dart', allFiles),
    'lib/features/models/user.dart',
  );
  assert.equal(
    resolver.resolve('../shared/helpers.dart', 'lib/features/entry.dart', allFiles),
    'lib/shared/helpers.dart',
  );
});

test('CSharpResolver 支持 global/static/alias using 提取', () => {
  const resolver = new CSharpResolver();
  const content = `
using System.Text;
using static System.Math;
global using global::System.Linq;
using IO = System.IO;
`;

  assert.deepEqual(resolver.extract(content), ['System.Text', 'System.Math', 'global::System.Linq', 'System.IO']);

  const allFiles = new Set<string>([
    'src/System/Text.cs',
    'src/System/Math.cs',
    'src/System/Linq.cs',
    'src/System/IO.cs',
  ]);

  assert.equal(
    resolver.resolve('global::System.Linq', 'src/App/Program.cs', allFiles),
    'src/System/Linq.cs',
  );
});

setTimeout(() => {
  if (process.exitCode && process.exitCode !== 0) {
    process.exit(process.exitCode);
  }
}, 0);
