import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { registeredTools } from './roster.js';

const readJson = (p: string) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));
// TOAST_WS_PORT (src/index.ts) plus the two @fetchproxy/server reads we never
// override. FETCHPROXY_WS_PORT is inert (we always pass port) and --define'd away.
const ENV_KEYS = ['FETCHPROXY_IDENTITY_DIR', 'FETCHPROXY_WS_HOST', 'TOAST_WS_PORT'];

describe('distribution manifests', () => {
  it('manifest tools[] is exactly the served roster', () => {
    const names = readJson('manifest.json').tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(registeredTools().map((t) => t.name).sort());
  });

  it('manifest and server.json declare every honoured env key, all optional', () => {
    const manifest = readJson('manifest.json');
    expect(Object.keys(manifest.server.mcp_config.env).sort()).toEqual(ENV_KEYS);
    for (const v of Object.values(manifest.user_config as Record<string, { required: boolean }>)) expect(v.required).toBe(false);
    const vars = readJson('server.json').packages[0].environmentVariables as { name: string; isRequired: boolean }[];
    expect(vars.map((v) => v.name).sort()).toEqual(ENV_KEYS);
    expect(vars.every((v) => !v.isRequired)).toBe(true);
  });

  it('server.json description fits the registry\'s 100-character cap', () => {
    expect(readJson('server.json').description.length).toBeLessThanOrEqual(100);
  });

  it('every versioned manifest agrees with package.json', () => {
    const v = readJson('package.json').version;
    const server = readJson('server.json');
    const market = readJson('.claude-plugin/marketplace.json');
    expect([
      readJson('manifest.json').version,
      server.version,
      ...server.packages.map((p: { version: string }) => p.version),
      readJson('.claude-plugin/plugin.json').version,
      market.metadata.version,
      ...market.plugins.map((p: { version: string }) => p.version),
    ]).toEqual(Array(6).fill(v));
  });
});
