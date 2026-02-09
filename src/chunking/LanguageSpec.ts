/**
 * 多语言配置规范
 *
 * 定义每种语言的层级节点类型和名称提取字段，
 * 用于在遍历 AST 时捕获语义层级。
 */

export interface LanguageSpecConfig {
  /** 触发上下文更新的节点类型 */
  hierarchy: Set<string>;
  /** 提取名称的字段列表（按优先级顺序） */
  nameFields: string[];
  /** 名称节点类型（用于遍历 namedChildren 时识别名称节点） */
  nameNodeTypes: Set<string>;
  /** 节点类型到前缀的映射（用于生成 contextPath） */
  prefixMap: Record<string, string>;
  /** 注释节点类型（用于前向吸附） */
  commentTypes: Set<string>;
}

/**
 * 语言规范映射表
 */
const LANGUAGE_SPECS: Record<string, LanguageSpecConfig> = {
  typescript: {
    hierarchy: new Set([
      'class_declaration',
      'abstract_class_declaration',
      'interface_declaration',
      'function_declaration',
      'generator_function_declaration',
      'method_definition',
      'arrow_function',
      'export_statement',
      'import_statement',
    ]),
    nameFields: ['name', 'id'],
    nameNodeTypes: new Set(['identifier', 'type_identifier', 'property_identifier']),
    prefixMap: {
      class_declaration: 'class ',
      abstract_class_declaration: 'abstract class ',
      interface_declaration: 'interface ',
      function_declaration: 'fn ',
      generator_function_declaration: 'fn* ',
      method_definition: '',
      arrow_function: '',
    },
    commentTypes: new Set(['comment']),
  },

  javascript: {
    hierarchy: new Set([
      'class_declaration',
      'function_declaration',
      'generator_function_declaration',
      'method_definition',
      'arrow_function',
    ]),
    nameFields: ['name', 'id'],
    nameNodeTypes: new Set(['identifier', 'property_identifier']),
    prefixMap: {
      class_declaration: 'class ',
      function_declaration: 'fn ',
      generator_function_declaration: 'fn* ',
      method_definition: '',
      arrow_function: '',
    },
    commentTypes: new Set(['comment']),
  },

  python: {
    hierarchy: new Set(['class_definition', 'function_definition', 'decorated_definition']),
    nameFields: ['name'],
    nameNodeTypes: new Set(['identifier']),
    prefixMap: {
      class_definition: 'class ',
      function_definition: 'def ',
      decorated_definition: '',
    },
    commentTypes: new Set(['comment']),
  },

  go: {
    hierarchy: new Set([
      'function_declaration',
      'method_declaration',
      'type_spec',
      'type_declaration',
      'struct_type',
      'interface_type',
    ]),
    nameFields: ['name'],
    nameNodeTypes: new Set(['identifier', 'type_identifier', 'field_identifier']),
    prefixMap: {
      function_declaration: 'func ',
      method_declaration: 'func ',
      type_spec: 'type ',
      type_declaration: 'type ',
      struct_type: 'struct ',
      interface_type: 'interface ',
    },
    commentTypes: new Set(['comment']),
  },

  rust: {
    hierarchy: new Set([
      'function_item',
      'struct_item',
      'enum_item',
      'trait_item',
      'impl_item',
      'mod_item',
      'type_item',
    ]),
    nameFields: ['name'],
    nameNodeTypes: new Set(['identifier', 'type_identifier']),
    prefixMap: {
      function_item: 'fn ',
      struct_item: 'struct ',
      enum_item: 'enum ',
      trait_item: 'trait ',
      impl_item: 'impl ',
      mod_item: 'mod ',
      type_item: 'type ',
    },
    commentTypes: new Set(['line_comment', 'block_comment']),
  },

  java: {
    hierarchy: new Set([
      'class_declaration',
      'interface_declaration',
      'enum_declaration',
      'annotation_type_declaration',
      'method_declaration',
      'constructor_declaration',
      'record_declaration',
    ]),
    nameFields: ['name', 'identifier'],
    nameNodeTypes: new Set(['identifier']),
    prefixMap: {
      class_declaration: 'class ',
      interface_declaration: 'interface ',
      enum_declaration: 'enum ',
      annotation_type_declaration: '@interface ',
      method_declaration: '',
      constructor_declaration: '',
      record_declaration: 'record ',
    },
    commentTypes: new Set(['line_comment', 'block_comment']),
  },

  kotlin: {
    hierarchy: new Set([
      'class_declaration',
      'object_declaration',
      'function_declaration',
      'property_declaration',
      'type_alias',
    ]),
    nameFields: ['name', 'identifier'],
    nameNodeTypes: new Set(['type_identifier', 'simple_identifier', 'identifier']),
    prefixMap: {
      class_declaration: 'class ',
      object_declaration: 'object ',
      function_declaration: 'fun ',
      property_declaration: 'prop ',
      type_alias: 'typealias ',
    },
    commentTypes: new Set(['line_comment', 'multiline_comment']),
  },

  php: {
    hierarchy: new Set([
      'class_declaration',
      'interface_declaration',
      'trait_declaration',
      'enum_declaration',
      'function_definition',
      'method_declaration',
      'namespace_definition',
      'namespace_use_declaration',
      'use_declaration',
      'property_declaration',
    ]),
    nameFields: ['name', 'identifier'],
    nameNodeTypes: new Set(['name', 'qualified_name', 'identifier', 'variable_name']),
    prefixMap: {
      class_declaration: 'class ',
      interface_declaration: 'interface ',
      trait_declaration: 'trait ',
      enum_declaration: 'enum ',
      function_definition: 'fn ',
      method_declaration: '',
      namespace_definition: 'namespace ',
      namespace_use_declaration: 'use ',
      use_declaration: 'use ',
      property_declaration: 'prop ',
    },
    commentTypes: new Set(['comment']),
  },

  ruby: {
    hierarchy: new Set([
      'class',
      'module',
      'method',
      'singleton_method',
      'call',
      'alias',
      'singleton_class',
    ]),
    nameFields: ['name', 'identifier', 'constant'],
    nameNodeTypes: new Set(['constant', 'identifier', '_method_name']),
    prefixMap: {
      class: 'class ',
      module: 'module ',
      method: 'def ',
      singleton_method: 'def ',
      call: '',
      alias: 'alias ',
      singleton_class: 'class << ',
    },
    commentTypes: new Set(['comment']),
  },

  swift: {
    hierarchy: new Set([
      'class_declaration',
      'struct',
      'enum',
      'protocol_declaration',
      'extension',
      'actor',
      'function_declaration',
      'init_declaration',
      'deinit_declaration',
      'import_declaration',
      'property_declaration',
      'typealias_declaration',
    ]),
    nameFields: ['name', 'identifier'],
    nameNodeTypes: new Set(['simple_identifier', 'type_identifier', 'identifier']),
    prefixMap: {
      class_declaration: 'class ',
      struct: 'struct ',
      enum: 'enum ',
      protocol_declaration: 'protocol ',
      extension: 'extension ',
      actor: 'actor ',
      function_declaration: 'func ',
      init_declaration: 'init ',
      deinit_declaration: 'deinit ',
      import_declaration: 'import ',
      property_declaration: 'var ',
      typealias_declaration: 'typealias ',
    },
    commentTypes: new Set(['comment', 'multiline_comment']),
  },

  dart: {
    hierarchy: new Set([
      'class_definition',
      'enum_declaration',
      'mixin_declaration',
      'extension_declaration',
      'function_signature',
      'method_signature',
      'constructor_signature',
      'factory_constructor_signature',
      'import_specification',
      'import_or_export',
      'type_alias',
      'typedef',
    ]),
    nameFields: ['name', 'identifier'],
    nameNodeTypes: new Set(['identifier', 'type_identifier', 'scoped_identifier']),
    prefixMap: {
      class_definition: 'class ',
      enum_declaration: 'enum ',
      mixin_declaration: 'mixin ',
      extension_declaration: 'extension ',
      function_signature: 'fn ',
      method_signature: '',
      constructor_signature: 'ctor ',
      factory_constructor_signature: 'factory ',
      import_specification: 'import ',
      import_or_export: 'import/export ',
      type_alias: 'typealias ',
      typedef: 'typedef ',
    },
    commentTypes: new Set(['comment', 'documentation_comment']),
  },

  c: {
    hierarchy: new Set([
      'function_definition',
      'struct_specifier',
      'union_specifier',
      'enum_specifier',
      'type_definition',
    ]),
    nameFields: ['declarator', 'name'],
    nameNodeTypes: new Set(['identifier', 'type_identifier', 'field_identifier']),
    prefixMap: {
      function_definition: '',
      struct_specifier: 'struct ',
      union_specifier: 'union ',
      enum_specifier: 'enum ',
      type_definition: 'typedef ',
    },
    commentTypes: new Set(['comment']),
  },

  cpp: {
    hierarchy: new Set([
      'function_definition',
      'class_specifier',
      'struct_specifier',
      'union_specifier',
      'enum_specifier',
      'namespace_definition',
      'template_declaration',
      'type_definition',
    ]),
    nameFields: ['declarator', 'name'],
    nameNodeTypes: new Set(['identifier', 'type_identifier', 'field_identifier', 'namespace_identifier']),
    prefixMap: {
      function_definition: '',
      class_specifier: 'class ',
      struct_specifier: 'struct ',
      union_specifier: 'union ',
      enum_specifier: 'enum ',
      namespace_definition: 'namespace ',
      template_declaration: 'template ',
      type_definition: 'typedef ',
    },
    commentTypes: new Set(['comment']),
  },

  c_sharp: {
    hierarchy: new Set([
      'class_declaration',
      'interface_declaration',
      'struct_declaration',
      'enum_declaration',
      'record_declaration',
      'method_declaration',
      'constructor_declaration',
      'property_declaration',
      'namespace_declaration',
    ]),
    nameFields: ['name', 'identifier'],
    nameNodeTypes: new Set(['identifier']),
    prefixMap: {
      class_declaration: 'class ',
      interface_declaration: 'interface ',
      struct_declaration: 'struct ',
      enum_declaration: 'enum ',
      record_declaration: 'record ',
      method_declaration: '',
      constructor_declaration: '',
      property_declaration: '',
      namespace_declaration: 'namespace ',
    },
    commentTypes: new Set(['comment']),
  },
};

/**
 * 获取指定语言的规范配置
 * @param language 语言标识
 * @returns 语言规范配置，如果不支持则返回 null
 */
export function getLanguageSpec(language: string): LanguageSpecConfig | null {
  return LANGUAGE_SPECS[language] ?? null;
}
