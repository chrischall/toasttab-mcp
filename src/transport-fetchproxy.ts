// Adapter that lets @fetchproxy/server satisfy ToastTransport.
//
// Every request rides the user's own browser: their cookies, their TLS, and
// their Cloudflare clearance. That last one is the reason this server has no
// direct mode. order.toasttab.com, www.toasttab.com/local and the GraphQL
// gateway all sit behind Cloudflare, which answers a server-side client with a
// managed challenge (order/www) or a bare `{"errors":[{"message":"Forbidden"}]}`
// (the gateway) — observed 2026-10-24 from a datacenter IP.
import {
  createFetchproxyTransport,
  type FetchproxyTransport as FetchproxyTransportAdapter,
} from '@chrischall/mcp-utils/fetchproxy';
import { FetchproxyNoTabError } from '@fetchproxy/server';
import type { FetchInit, FetchResult, ToastTransport } from './transport.js';

export interface FetchproxyTransportOptions {
  port?: number;
  version: string;
}

/**
 * Tabs that can relay a request to the API host, tried in order.
 *
 * `ws-api.toasttab.com` is an API host: a tab pointed at it renders Chrome's
 * own error page, which never hosts a content script, so it can never relay
 * its own requests (fetchproxy's `viaTab` docs). Toast's online-ordering app
 * on order.toasttab.com is what calls the gateway — the gateway answers
 * `Access-Control-Allow-Origin: https://order.toasttab.com` with credentials —
 * so an ordering tab is the natural relay; www.toasttab.com is the fallback.
 */
export const API_RELAY_TABS: readonly string[] = [
  'https://order.toasttab.com/',
  'https://www.toasttab.com/',
];

export class FetchproxyTransport implements ToastTransport {
  private readonly inner: FetchproxyTransportAdapter;

  constructor(opts: FetchproxyTransportOptions) {
    this.inner = createFetchproxyTransport({
      port: opts.port ?? 37149,
      serverName: 'toasttab-mcp',
      version: opts.version,
      // Subdomains (order., www., ws-api.) match the declared root.
      domains: ['toasttab.com'],
      capabilities: ['fetch'],
    });
  }

  start(): Promise<void> {
    return this.inner.start();
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  bridgeStatus(): unknown {
    return this.inner.status();
  }

  runProbe(fetchFn: (path: string) => Promise<unknown>, probePath: string): Promise<unknown> {
    return this.inner.runProbe(fetchFn, probePath);
  }

  async fetch(init: FetchInit): Promise<FetchResult> {
    const issue = async (viaTab?: string): Promise<FetchResult> => {
      const response = await this.inner.server.request(init.method, init.path, {
        subdomain: init.host,
        headers: init.headers,
        ...(viaTab === undefined ? {} : { viaTab }),
      });
      return { status: response.status, body: response.body, url: response.url };
    };
    // Page hosts relay through their own tab (fetchproxy's default).
    if (init.host !== 'ws-api') return issue();
    let lastMiss: unknown;
    for (const tab of API_RELAY_TABS) {
      try {
        return await issue(tab);
      } catch (e) {
        if (!(e instanceof FetchproxyNoTabError)) throw e;
        lastMiss = e;
      }
    }
    throw new Error(
      'No toasttab.com tab is open to relay through. Open https://order.toasttab.com (any restaurant\'s ordering page) in the browser running the ContextMint Bridge extension, then retry.',
      { cause: lastMiss },
    );
  }
}
