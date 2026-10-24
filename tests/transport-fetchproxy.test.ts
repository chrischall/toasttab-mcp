import { describe, expect, it, vi } from 'vitest';
import { FetchproxyNoTabError } from '@fetchproxy/server';
import { API_RELAY_TABS, APP_COOKIE_KEYS, FetchproxyTransport } from '../src/transport-fetchproxy.js';

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
    expect(request).toHaveBeenCalledWith('GET', '/p', expect.objectContaining({ subdomain: 'ws-api', viaTab: API_RELAY_TABS.order }));
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

  it('relays guest requests through a toast.app tab, and addresses toast.app by domain', async () => {
    const { t, request } = withRequest(async () => ok);
    await t.fetch({ host: 'ws-api', path: '/p', method: 'GET', relay: 'app' });
    expect(request.mock.calls[0][2]).toMatchObject({ domain: 'toasttab.com', subdomain: 'ws-api', viaTab: 'https://toast.app/' });
    await t.fetch({ host: 'app', path: '/x', method: 'GET' });
    expect(request.mock.calls[1][2]).toMatchObject({ domain: 'toast.app' });
    expect(request.mock.calls[1][2]).not.toHaveProperty('subdomain');
    expect(request.mock.calls[1][2]).not.toHaveProperty('viaTab');
  });

  it('names a missing toast.app tab with the toast.app remedy', async () => {
    const { t } = withRequest(async () => { throw new FetchproxyNoTabError('no tab'); });
    await expect(t.fetch({ host: 'ws-api', path: '/p', method: 'GET', relay: 'app' })).rejects.toThrow(/No toast\.app tab/);
  });

  it('lets page hosts relay through their own tab', async () => {
    const { t, request } = withRequest(async () => ok);
    await t.fetch({ host: 'order', path: '/online/x', method: 'GET' });
    expect(request.mock.calls[0][2]).not.toHaveProperty('viaTab');
    expect(request.mock.calls[0][2]).toMatchObject({ subdomain: 'order' });
  });
});

describe('FetchproxyTransport.readAppCookie', () => {
  function withCookies(fn: (opts: Record<string, unknown>) => Promise<string>) {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const readCookies = vi.fn(fn);
    (t as unknown as { inner: { server: { readCookies: typeof readCookies } } }).inner.server.readCookies = readCookies;
    return { t, readCookies };
  }

  it('declares only the access cookie, never the refresh token', () => {
    expect([...APP_COOKIE_KEYS]).toEqual(['toast-customer-access']);
  });

  it('reads one named cookie from toast.app and decodes it', async () => {
    const { t, readCookies } = withCookies(async () => 'other=1; toast-customer-access=a.b%2Bc.d');
    expect(await t.readAppCookie('toast-customer-access')).toBe('a.b+c.d');
    expect(readCookies).toHaveBeenCalledWith({ domain: 'toast.app', keys: ['toast-customer-access'] });
  });

  it('reads an absent or empty cookie as signed out', async () => {
    expect(await withCookies(async () => '').t.readAppCookie('toast-customer-access')).toBeNull();
    expect(await withCookies(async () => 'toast-customer-access=').t.readAppCookie('toast-customer-access')).toBeNull();
  });

  it('turns a missing toast.app tab into its remedy and rethrows anything else', async () => {
    await expect(withCookies(async () => { throw new FetchproxyNoTabError('no tab'); }).t.readAppCookie('x')).rejects.toThrow(/No toast\.app tab/);
    await expect(withCookies(async () => { throw new Error('bridge down'); }).t.readAppCookie('x')).rejects.toThrow('bridge down');
  });
});
