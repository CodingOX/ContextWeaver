import Parser from 'tree-sitter';

export interface LanguageRuntime {
  id: string;
  languages: readonly string[];
  canParse(language: string): boolean;
  getParser(language: string): Promise<Parser | null>;
}

type TreeSitterLanguage = unknown;

const GRAMMAR_MODULES: Record<string, string> = {
  c: 'tree-sitter-c',
  php: 'tree-sitter-php',
  rust: 'tree-sitter-rust',
  swift: 'tree-sitter-swift',
};

class Ts22Runtime implements LanguageRuntime {
  id = 'plugin-ts22';

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
      console.warn(`[Ts22Runtime] setLanguage failed for ${language}: ${error.message}`);
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

      if (language === 'php') {
        grammar = grammarModule.default?.php ?? grammarModule.php;
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
          `[Ts22Runtime] Could not extract grammar for ${language} from module ${moduleName}`,
        );
        return null;
      }

      this.loadedGrammars.set(language, grammar);
      return grammar;
    } catch (err) {
      const error = err as { message?: string };
      console.warn(`[Ts22Runtime] Failed to load grammar for ${language}: ${error.message}`);
      return null;
    }
  }
}

export function createRuntime(): LanguageRuntime {
  return new Ts22Runtime();
}
