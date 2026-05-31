import Parser from 'tree-sitter';
import type { LanguageRuntime } from './LanguageRuntime.js';

type TreeSitterLanguage = unknown;

const GRAMMAR_MODULES: Record<string, string> = {
  javascript: 'tree-sitter-javascript',
  python: 'tree-sitter-python',
  go: 'tree-sitter-go',
};

export class BuiltinRuntimeTs25 implements LanguageRuntime {
  id = 'builtin-ts25';

  readonly languages = Object.keys(GRAMMAR_MODULES);

  private loadedGrammars: Map<string, TreeSitterLanguage> = new Map();

  canParse(language: string): boolean {
    return Object.hasOwn(GRAMMAR_MODULES, language);
  }

  async getParser(language: string): Promise<Parser | null> {
    const grammar = await this.loadGrammar(language);
    if (!grammar) return null;

    const parser = new Parser();

    try {
      parser.setLanguage(grammar as Parser.Language);
      return parser;
    } catch (err) {
      const error = err as { message?: string };
      console.warn(`[BuiltinRuntimeTs25] setLanguage failed for ${language}: ${error.message}`);
      return null;
    }
  }

  private async loadGrammar(language: string): Promise<TreeSitterLanguage | null> {
    const cached = this.loadedGrammars.get(language);
    if (cached) return cached;

    const moduleName = GRAMMAR_MODULES[language];
    if (!moduleName) return null;

    try {
      const grammarModule = await import(moduleName);
      const exported = grammarModule.default ?? grammarModule;

      let grammar: TreeSitterLanguage | null = null;

      if (exported && typeof exported === 'object' && 'nodeTypeInfo' in exported) {
        grammar = exported;
      } else if (exported?.language) {
        grammar = exported.language;
      } else if (exported?.[language]) {
        grammar = exported[language];
      }

      if (!grammar) {
        console.warn(
          `[BuiltinRuntimeTs25] Could not extract grammar for ${language} from module ${moduleName}`,
        );
        return null;
      }

      this.loadedGrammars.set(language, grammar);
      return grammar;
    } catch (err) {
      const error = err as { message?: string };
      console.warn(`[BuiltinRuntimeTs25] Failed to load grammar for ${language}: ${error.message}`);
      return null;
    }
  }
}
