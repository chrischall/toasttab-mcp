import { describe, expect, it, vi } from 'vitest';
import { FetchproxyNoTabError } from '@fetchproxy/server';
import { API_RELAY_TAB, FetchproxyTransport } from '../src/transport-fetchproxy.js';

type RequestFn = (method: string, path: string, opts: Record<string, unknown>) => Promise<{ status: number; body: string; url: string }>;

function withRequest(fn: RequestFn) {
  const t = new FetchproxyTransport({ version: '0.0.0' });
  const request = vi.fn(fn);
  (t as unknown as { inner: { server: { request: typeof request } } }).inner.server.request = request;
  return { t, request };
}

const ok = { status: 200, body: '{}', url: 'https://ws-api.toasttab.com/x' };

describe('FetchproxyTransport.fetch', () => {
  it('relays API requests through an ordering tab', async () => {
    const { t, request } = withRequest(async () => ok);
    await t.fetch({ host: 'ws-api', path: '/p', method: 'GET' });
    expect(request).toHaveBeenCalledWith('GET', '/p', expect.objectContaining({ subdomain: 'ws-api', viaTab: API_RELAY_TAB }));
  });

  it('explains what to open when no ordering tab exists, for the API host and the page host alike', async () => {
    const { t } = withRequest(async () => { throw new FetchproxyNoTabError('no tab'); });
    await expect(t.fetch({ host: 'ws-api', path: '/p', method: 'GET' })).rejects.toThrow(/order\.toasttab\.com\/online/);
    await expect(t.fetch({ host: 'order', path: '/online/x', method: 'GET' })).rejects.toThrow(/order\.toasttab\.com\/online/);
  });

  it('rethrows other bridge errors at once', async () => {
    const { t, request } = withRequest(async () => { throw new Error('bridge down'); });
    await expect(t.fetch({ host: 'ws-api', path: '/p', method: 'GET' })).rejects.toThrow('bridge down');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('lets page hosts relay through their own tab', async () => {
    const { t, request } = withRequest(async () => ok);
    await t.fetch({ host: 'order', path: '/online/x', method: 'GET' });
    expect(request.mock.calls[0][2]).not.toHaveProperty('viaTab');
    expect(request.mock.calls[0][2]).toMatchObject({ subdomain: 'order' });
  });
});
