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
  /** Which toasttab.com host to address. */
  host: ToastHost;
  method: 'GET';
  headers?: Record<string, string>;
}

/** Every host this server reaches, as the subdomain of toasttab.com. */
export type ToastHost = 'ws-api' | 'order';

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
  /** Bridge liveness, for `toast_healthcheck`. */
  bridgeStatus?(): unknown;
  /** One probe round-trip, for `toast_healthcheck`. */
  runProbe?(fetchFn: (path: string) => Promise<unknown>, probePath: string): Promise<unknown>;
}
