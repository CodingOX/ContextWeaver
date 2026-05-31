import type { LanguageRuntime } from './LanguageRuntime.js';

export class RuntimeRegistry {
  private runtimes: LanguageRuntime[] = [];
  private runtimeByLanguage: Map<string, LanguageRuntime> = new Map();

  register(runtime: LanguageRuntime): void {
    if (this.runtimes.some((item) => item.id === runtime.id)) {
      throw new Error(`Runtime id "${runtime.id}" 已注册`);
    }

    this.runtimes.push(runtime);

    for (const language of runtime.languages) {
      if (!this.runtimeByLanguage.has(language)) {
        this.runtimeByLanguage.set(language, runtime);
      }
    }
  }

  listLanguages(): string[] {
    return [...this.runtimeByLanguage.keys()];
  }

  findRuntime(language: string): LanguageRuntime | null {
    const indexed = this.runtimeByLanguage.get(language);
    if (indexed?.canParse(language)) return indexed;

    for (const runtime of this.runtimes) {
      if (runtime.canParse(language)) return runtime;
    }

    return null;
  }
}
