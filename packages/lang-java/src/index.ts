import Parser from 'tree-sitter';

export interface LanguageRuntime {
  id: string;
  languages: readonly string[];
  canParse(language: string): boolean;
  getParser(language: string): Promise<Parser | null>;
}

type TreeSitterLanguage = unknown;

const LANGUAGE = 'java';
const GRAMMAR_MODULE = 'tree-sitter-java';

class Runtime implements LanguageRuntime {
  id = 'plugin-java';

  readonly languages = [LANGUAGE] as const;

  private grammar: TreeSitterLanguage | null = null;

  canParse(language: string): boolean {
    return language === LANGUAGE;
  }

  async getParser(language: string): Promise<Parser | null> {
    if (!this.canParse(language)) return null;

    const grammar = await this.loadGrammar();
    if (!grammar) return null;

    const parser = new Parser();
    try {
      parser.setLanguage(grammar as never);
      return parser;
    } catch (err) {
      const error = err as { message?: string };
      console.warn('[plugin-java] setLanguage failed for ' + language + ': ' + error.message);
      return null;
    }
  }

  private async loadGrammar(): Promise<TreeSitterLanguage | null> {
    if (this.grammar) return this.grammar;

    try {
      const grammarModule = await import(GRAMMAR_MODULE);
      let grammar: TreeSitterLanguage | null = null;

      const exported = grammarModule.default ?? grammarModule;
      if (exported && typeof exported === 'object' && 'nodeTypeInfo' in exported) {
        grammar = exported;
      } else if (exported?.language) {
        grammar = exported.language;
      } else if (exported?.['java']) {
        grammar = exported['java'];
      }

      if (!grammar) {
        console.warn('[plugin-java] Could not extract grammar from module ' + GRAMMAR_MODULE);
        return null;
      }

      this.grammar = grammar;
      return grammar;
    } catch (err) {
      const error = err as { message?: string };
      console.warn('[plugin-java] Failed to load grammar from ' + GRAMMAR_MODULE + ': ' + error.message);
      return null;
    }
  }
}

export function createRuntime(): LanguageRuntime {
  return new Runtime();
}
