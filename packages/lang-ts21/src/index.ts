import Parser from 'tree-sitter';

export interface LanguageRuntime {
  id: string;
  languages: readonly string[];
  canParse(language: string): boolean;
  getParser(language: string): Promise<Parser | null>;
}

type TreeSitterLanguage = unknown;

const GRAMMAR_MODULES: Record<string, string> = {
  c_sharp: 'tree-sitter-c-sharp',
  cpp: 'tree-sitter-cpp',
  java: 'tree-sitter-java',
  kotlin: 'tree-sitter-kotlin',
  ruby: 'tree-sitter-ruby',
  typescript: 'tree-sitter-typescript',
};

class Ts21Runtime implements LanguageRuntime {
  id = 'plugin-ts21';

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
      parser.setLanguage(grammar as never);
      return parser;
    } catch (err) {
      const error = err as { message?: string };
      console.warn(`[Ts21Runtime] setLanguage failed for ${language}: ${error.message}`);
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
      let grammar: TreeSitterLanguage | null = null;

      if (language === 'typescript') {
        grammar = grammarModule.default?.typescript ?? grammarModule.typescript;
      } else {
        const exported = grammarModule.default ?? grammarModule;

        if (exported && typeof exported === 'object' && 'nodeTypeInfo' in exported) {
          grammar = exported;
        } else if (exported?.language) {
          grammar = exported.language;
        } else if (exported?.[language]) {
          grammar = exported[language];
        }
      }

      if (!grammar) {
        console.warn(
          `[Ts21Runtime] Could not extract grammar for ${language} from module ${moduleName}`,
        );
        return null;
      }

      this.loadedGrammars.set(language, grammar);
      return grammar;
    } catch (err) {
      const error = err as { message?: string };
      console.warn(`[Ts21Runtime] Failed to load grammar for ${language}: ${error.message}`);
      return null;
    }
  }
}

export function createRuntime(): LanguageRuntime {
  return new Ts21Runtime();
}
