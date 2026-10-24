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
import { GUEST_ACCESS_COOKIE } from './session.js';
import type { FetchInit, FetchResult, RelaySite, ToastHost, ToastTransport } from './transport.js';

export interface FetchproxyTransportOptions {
  port?: number;
  version: string;
}

/**
 * The tab that relays requests to the API host, per site.
 *
 * `ws-api.toasttab.com` is an API host: a tab pointed at it renders Chrome's
 * own error page, which never hosts a content script, so it can never relay
 * its own requests (fetchproxy's `viaTab` docs). The gateway answers CORS for
 * both of Toast's diner sites with credentials, so a request rides a tab of
 * the site whose session it carries: an order.toasttab.com ordering page, or
 * toast.app for the signed-in guest. www.toasttab.com cannot be a fallback:
 * it redirects to toast.app (observed 2026-10-24), so no tab ever sits on it.
 */
export const API_RELAY_TABS: Readonly<Record<RelaySite, string>> = {
  order: 'https://order.toasttab.com/',
  app: 'https://toast.app/',
};

/**
 * The one cookie this server may read: toast.app's short-lived access token.
 * Its sibling `toast-customer-refresh` is deliberately NOT declared —
 * refreshing rotates it, and a rotated copy kept here would sign the user out
 * of their own tab.
 */
export const APP_COOKIE_KEYS = [GUEST_ACCESS_COOKIE] as const;

const HOSTS: Record<ToastHost, { domain: string; subdomain?: string }> = {
  'ws-api': { domain: 'toasttab.com', subdomain: 'ws-api' },
  order: { domain: 'toasttab.com', subdomain: 'order' },
  app: { domain: 'toast.app' },
};

const NO_TAB_REMEDY: Record<RelaySite, string> = {
  order:
    "No order.toasttab.com tab is open to relay through. Open any restaurant's ordering page (https://order.toasttab.com/online/<restaurant>) in the browser running the ContextMint Bridge extension, then retry.",
  app: 'No toast.app tab is open to relay through. Open https://toast.app in the browser running the ContextMint Bridge extension, sign in, then retry.',
};

export class FetchproxyTransport implements ToastTransport {
  private readonly inner: FetchproxyTransportAdapter;

  constructor(opts: FetchproxyTransportOptions) {
    this.inner = createFetchproxyTransport({
      port: opts.port ?? 37149,
      serverName: 'toasttab-mcp',
      version: opts.version,
      // Subdomains (order., ws-api.) match the declared root; toast.app is
      // the guest web app. Every request names its domain (HOSTS).
      domains: ['toasttab.com', 'toast.app'],
      capabilities: ['fetch', 'read_cookies'],
      cookieKeys: [...APP_COOKIE_KEYS],
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
    const site: RelaySite = init.host === 'ws-api' ? (init.relay ?? 'order') : init.host === 'app' ? 'app' : 'order';
    try {
      const response = await this.inner.server.request(init.method, init.path, {
        ...HOSTS[init.host],
        headers: init.headers,
        // Page hosts relay through their own tab (fetchproxy's default).
        ...(init.host === 'ws-api' ? { viaTab: API_RELAY_TABS[site] } : {}),
      });
      return { status: response.status, body: response.body, url: response.url };
    } catch (e) {
      if (!(e instanceof FetchproxyNoTabError)) throw e;
      throw new Error(NO_TAB_REMEDY[site], { cause: e });
    }
  }

  async readAppCookie(name: string): Promise<string | null> {
    try {
      const jar = await this.inner.server.readCookies({ domain: 'toast.app', keys: [name] });
      for (const pair of jar.split(';')) {
        const eq = pair.indexOf('=');
        if (eq > 0 && pair.slice(0, eq).trim() === name) {
          const value = decodeURIComponent(pair.slice(eq + 1).trim());
          return value === '' ? null : value;
        }
      }
      return null;
    } catch (e) {
      if (!(e instanceof FetchproxyNoTabError)) throw e;
      throw new Error(NO_TAB_REMEDY.app, { cause: e });
    }
  }
}
