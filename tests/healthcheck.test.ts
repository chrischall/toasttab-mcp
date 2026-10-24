import { describe, expect, it } from 'vitest';
import type { ToastClient } from '../src/client.js';
import type { ToastTransport } from '../src/transport.js';
import { registerHealthcheckTools } from '../src/tools/healthcheck.js';

describe('registerHealthcheckTools', () => {
  it('registers nothing on a transport without a bridge', () => {
    const names: string[] = [];
    const server = { registerTool: (n: string) => void names.push(n) } as never;
    registerHealthcheckTools(server, {} as ToastClient, { start: async () => {}, close: async () => {}, fetch: async () => ({ status: 200, body: '', url: '' }) } as ToastTransport);
    expect(names).toEqual([]);
  });
});
