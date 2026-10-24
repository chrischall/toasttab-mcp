// Transport-agnostic interface for the bridge that relays Toast requests
// through the user's own browser.
//
// There is one implementation, `transport-fetchproxy.ts`. The interface exists
// so ToastClient (and its tests) never import @fetchproxy/server: tests drive
// the client with an in-memory transport, and error mapping lives on the
// client, not the transport.

export interface FetchInit {
  /** Path-and-query on `host`, e.g. `/do-federated-gateway/v1/graphql?query=…`. */
  path: string;
  /** Which host to address. */
  host: ToastHost;
  method: 'GET';
  headers?: Record<string, string>;
  /**
   * For `ws-api` only: which signed-in site's tab relays the request. The
   * gateway's sessions belong to one site each (session.ts), so a request
   * rides a tab of the site that issued its session. Default `order`.
   */
  relay?: RelaySite;
}

/**
 * Every host this server reaches: `ws-api` / `order` are toasttab.com
 * subdomains, `app` is toast.app (Toast's guest web app).
 */
export type ToastHost = 'ws-api' | 'order' | 'app';

/** The two sites whose tabs can relay gateway requests. */
export type RelaySite = 'order' | 'app';

export interface FetchResult {
  status: number;
  /** Response body as a string. */
  body: string;
  /** Final URL after redirects. */
  url: string;
}

export interface ToastTransport {
  start(): Promise<void>;
  close(): Promise<void>;
  /** Round-trip one request. Resolves for every HTTP status; throws only on
   *  bridge-level failure (no extension, no tab, timeout). */
  fetch(init: FetchInit): Promise<FetchResult>;
  /**
   * Read one declared cookie of the user's toast.app session, or null when
   * it is not set (signed out). Optional: absent means account tools cannot
   * authenticate.
   */
  readAppCookie?(name: string): Promise<string | null>;
  /** Bridge liveness, for `toast_healthcheck`. */
  bridgeStatus?(): unknown;
  /** One probe round-trip, for `toast_healthcheck`. */
  runProbe?(fetchFn: (path: string) => Promise<unknown>, probePath: string): Promise<unknown>;
}
