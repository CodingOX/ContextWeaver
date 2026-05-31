import assert from 'node:assert/strict';
import test from 'node:test';

test('codeOnly filter excludes markdown language', async () => {
  const { createSearchFilter } = await import('../src/search/filtering.js');
  const filter = createSearchFilter({ codeOnly: true });

  assert.deepEqual(filter, { excludeLanguages: ['markdown'] });
});

test('matchesSearchFilter rejects excluded languages and path prefixes', async () => {
  const { matchesSearchFilter } = await import('../src/search/filtering.js');

  assert.equal(
    matchesSearchFilter(
      {
        excludeLanguages: ['markdown'],
        excludePathPrefixes: ['docs/'],
      },
      {
        filePath: 'README.md',
        language: 'markdown',
      },
    ),
    false,
  );

  assert.equal(
    matchesSearchFilter(
      {
        excludeLanguages: ['markdown'],
        excludePathPrefixes: ['docs/'],
      },
      {
        filePath: 'docs/guide.ts',
        language: 'typescript',
      },
    ),
    false,
  );

  assert.equal(
    matchesSearchFilter(
      {
        excludeLanguages: ['markdown'],
        excludePathPrefixes: ['docs/'],
      },
      {
        filePath: 'src/index.ts',
        language: 'typescript',
      },
    ),
    true,
  );
});

test('SearchService vectorRetrieve applies down-pushed and fallback filtering', async () => {
  const { SearchService } = await import('../src/search/SearchService.js');

  let capturedFilter: string | undefined;
  const service = new SearchService(
    'project-123',
    '/repo',
    undefined,
    {
      excludeLanguages: ['markdown'],
      excludePathPrefixes: ['docs/'],
    },
  ) as SearchService & {
    indexer: {
      textSearch: (query: string, limit: number, filter?: string) => Promise<
        Array<{
          file_path: string;
          chunk_index: number;
          _distance: number;
          language?: string;
        }>
      >;
    };
    vectorRetrieve: (query: string) => Promise<Array<{ filePath: string }>>;
  };

  service.indexer = {
    textSearch: async (_query, _limit, filter) => {
      capturedFilter = filter;
      return [
        {
          file_path: 'docs/guide.ts',
          chunk_index: 0,
          _distance: 0.1,
          language: 'typescript',
        },
        {
          file_path: 'src/index.ts',
          chunk_index: 1,
          _distance: 0.2,
          language: 'typescript',
        },
      ];
    },
  };

  const results = await service.vectorRetrieve('login flow');

  assert.deepEqual(
    results.map((item) => item.filePath),
    ['src/index.ts'],
  );
  assert.equal(capturedFilter, "language != 'markdown'");
});

test('GraphExpander expand applies request-level filter without cache pollution', async () => {
  const { GraphExpander } = await import('../src/search/GraphExpander.js');
  const { DEFAULT_CONFIG } = await import('../src/search/config.js');
  const expander = new GraphExpander('project-123', DEFAULT_CONFIG) as GraphExpander & {
    vectorStore: {
      getFilesChunks: (paths: string[]) => Promise<Map<string, Array<Record<string, unknown>>>>;
    };
    db: object;
    allFilePaths: Set<string>;
    expand: (
      seeds: Array<{
        filePath: string;
        chunkIndex: number;
        score: number;
        source: 'vector';
        record: Record<string, unknown>;
      }>,
      queryTokens?: Set<string>,
      filter?: { excludeLanguages?: string[] },
    ) => Promise<{ chunks: Array<{ filePath: string }>; stats: object }>;
    expandBreadcrumb: () => Promise<unknown[]>;
    expandImports: () => Promise<unknown[]>;
  };

  expander.vectorStore = {
    getFilesChunks: async () =>
      new Map([
        [
          'src/index.ts',
          [
            {
              chunk_id: 'src/index.ts#hash#1',
              file_path: 'src/index.ts',
              file_hash: 'hash',
              chunk_index: 1,
              vector: [0.1],
              display_code: '# docs',
              vector_text: '# docs',
              language: 'markdown',
              breadcrumb: 'README',
              start_index: 0,
              end_index: 6,
              raw_start: 0,
              raw_end: 6,
              vec_start: 0,
              vec_end: 6,
            },
          ],
        ],
      ]),
  };
  expander.db = {};
  expander.allFilePaths = new Set();
  expander.expandBreadcrumb = async () => [];
  expander.expandImports = async () => [];

  const seeds = [
    {
      filePath: 'src/index.ts',
      chunkIndex: 0,
      score: 1,
      source: 'vector' as const,
      record: {
        chunk_id: 'src/index.ts#hash#0',
        file_path: 'src/index.ts',
        file_hash: 'hash',
        chunk_index: 0,
        vector: [0.2],
        display_code: 'export const x = 1;',
        vector_text: 'export const x = 1;',
        language: 'typescript',
        breadcrumb: 'src/index.ts',
        start_index: 0,
        end_index: 19,
        raw_start: 0,
        raw_end: 19,
        vec_start: 0,
        vec_end: 19,
        _distance: 0,
      },
    },
  ];

  const unfiltered = await expander.expand(seeds);
  const filtered = await expander.expand(seeds, undefined, {
    excludeLanguages: ['markdown'],
  });

  assert.equal(unfiltered.chunks.length, 1);
  assert.equal(filtered.chunks.length, 0);
  assert.equal(unfiltered.chunks[0]?.filePath, 'src/index.ts');
});
