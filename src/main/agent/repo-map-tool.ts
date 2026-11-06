/**
 * RET-1 P3 · `repo_map` customTool：确定性文件/符号索引查询（只读、零 LLM）。
 * 口径：返回小答案（≤ maxChars），不返回整张图；查询为空只给文件索引。
 */
import { buildRepoMap, renderRepoMap, type RepoMap } from './repo-map.js';

export async function createRepoMapTool(root: string) {
  const [{ defineTool }, { Type }] = await Promise.all([
    import('@earendil-works/pi-coding-agent'),
    import('@earendil-works/pi-ai'),
  ]);
  let cached: RepoMap | null = null;
  const get = (): RepoMap => {
    cached ??= buildRepoMap(root);
    return cached;
  };
  return defineTool({
    name: 'repo_map',
    label: 'Repo Map',
    description:
      '查询本项目的确定性文件/符号索引（Rust fn/struct/enum/impl/mod、Cargo.toml、Markdown 标题）。' +
      '定位代码/文件时先用它，不要一上来就全仓 find/grep；query 为空只列文件索引。',
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: '文件名或符号名片段（不区分大小写）' })),
      pathPrefix: Type.Optional(Type.String({ description: '只查某个目录/文件前缀（项目根相对）' })),
      maxChars: Type.Optional(Type.Number({ description: '返回文本上限（缺省 4000）' })),
    }),
    async execute(_toolCallId, params) {
      const map = get();
      const result = renderRepoMap(map, {
        ...(params.query ? { query: params.query } : {}),
        ...(params.pathPrefix ? { pathPrefix: params.pathPrefix } : {}),
        ...(params.maxChars ? { maxChars: params.maxChars } : {}),
      });
      return {
        content: [{ type: 'text' as const, text: result.text }],
        details: {
          files: map.files,
          entries: map.entries.length,
          hits: result.hits,
          truncated: result.truncated,
          rootFiles: map.fileList.length,
        },
      };
    },
  });
}
