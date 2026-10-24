// Adapter that lets @fetchproxy/server satisfy ToastTransport.
//
// Every request rides the user's own browser: their cookies, their TLS, and
// their Cloudflare clearance. That last one is the reason this server has no
// direct mode. order.toasttab.com sits behind a Cloudflare managed challenge
// for server-side clients (observed 2026-10-24 from a datacenter IP), and the
// guest session the gateway needs (session.ts) is minted from that page.
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
 * The tab that relays requests to the API host.
 *
 * `ws-api.toasttab.com` is an API host: a tab pointed at it renders Chrome's
 * own error page, which never hosts a content script, so it can never relay
 * its own requests (fetchproxy's `viaTab` docs). Toast's online-ordering app
 * on order.toasttab.com is what calls the gateway — the gateway answers
 * `Access-Control-Allow-Origin: https://order.toasttab.com` with credentials —
 * so an ordering tab is the relay. www.toasttab.com cannot be a fallback: it
 * redirects to toast.app (observed 2026-10-24), so no tab ever sits on it.
 */
export const API_RELAY_TAB = 'https://order.toasttab.com/';

export class FetchproxyTransport implements ToastTransport {
  private readonly inner: FetchproxyTransportAdapter;

  constructor(opts: FetchproxyTransportOptions) {
    this.inner = createFetchproxyTransport({
      port: opts.port ?? 37149,
      serverName: 'toasttab-mcp',
      version: opts.version,
      // Subdomains (order., ws-api.) match the declared root.
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
    try {
      const response = await this.inner.server.request(init.method, init.path, {
        subdomain: init.host,
        headers: init.headers,
        // Page hosts relay through their own tab (fetchproxy's default).
        ...(init.host === 'ws-api' ? { viaTab: API_RELAY_TAB } : {}),
      });
      return { status: response.status, body: response.body, url: response.url };
    } catch (e) {
      if (!(e instanceof FetchproxyNoTabError)) throw e;
      throw new Error(
        'No order.toasttab.com tab is open to relay through. Open any restaurant\'s ordering page (https://order.toasttab.com/online/<restaurant>) in the browser running the ContextMint Bridge extension, then retry.',
        { cause: e },
      );
    }
  }
}
