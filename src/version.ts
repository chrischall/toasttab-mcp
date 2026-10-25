// The one release-please marker for this package's version. `index.ts` feeds
// it to the MCP server and to the fetchproxy bridge identity; never import
// package.json from src/ (esbuild would inline the whole manifest).
export const VERSION = '1.0.0'; // x-release-please-version
