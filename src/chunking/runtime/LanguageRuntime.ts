export interface LanguageRuntime {
  id: string;
  languages: readonly string[];
  canParse(language: string): boolean;
  getParser(language: string): Promise<unknown | null>;
}
