// An in-memory ToastTransport: records every request and answers from a
// handler, so tests drive the REAL ToastClient (path building, error mapping).
// Payloads here are synthetic, shaped after live answers captured 2026-10-24
// (see src/graphql.ts) — no real restaurant or session data.
//
// The guest-session page (session.ts) is answered automatically and kept out
// of `requests`, so a test about a tool sees only the gateway traffic. Tests
// about the session itself set `sessionPage` and read `sessionRequests`.
import { SESSION_PAGE_PATH } from '../src/session.js';
import type { FetchInit, FetchResult, ToastTransport } from '../src/transport.js';

export type Handler = (init: FetchInit, query: string | null) => FetchResult | Promise<FetchResult>;

export const SESSION_ID = 'TEST0SessionIdNotARealOne0000000000000000x';

/**
 * An order.toasttab.com page carrying a session, written the way the live
 * page writes it: a self-closing div whose base64 padding is entity-escaped.
 */
export function sessionPage(id = SESSION_ID, expiresAt = '2099-01-01T01:00:00Z', status = 404): FetchResult {
  const content = Buffer.from(JSON.stringify({ id, issuedAt: '2099-01-01T00:00:00Z', expiresAt }))
    .toString('base64')
    .replace(/=/g, '&#x3D;');
  return {
    status,
    url: `https://order.toasttab.com${SESSION_PAGE_PATH}`,
    body: `<!DOCTYPE html><html><head></head><body><script>/* app */</script><div id="session" data-content="${content}"/></body></html>`,
  };
}

export class FakeTransport implements ToastTransport {
  readonly requests: FetchInit[] = [];
  readonly sessionRequests: FetchInit[] = [];
  sessionPage: () => FetchResult = () => sessionPage();
  constructor(public handler: Handler) {}
  async start(): Promise<void> {}
  async close(): Promise<void> {}
  async fetch(init: FetchInit): Promise<FetchResult> {
    if (init.host === 'order' && init.path === SESSION_PAGE_PATH) {
      this.sessionRequests.push(init);
      return this.sessionPage();
    }
    this.requests.push(init);
    const query = new URL(init.path, 'https://x.invalid').searchParams.get('query');
    return this.handler(init, query);
  }
  /** The GraphQL documents sent, in order. */
  get queries(): string[] {
    return this.requests.map((r) => new URL(r.path, 'https://x.invalid').searchParams.get('query') ?? '');
  }
}

export const json = (body: unknown, status = 200): FetchResult => ({
  status,
  body: JSON.stringify(body),
  url: 'https://ws-api.toasttab.com/do-federated-gateway/v1/graphql',
});

export const GUID_A = '11111111-2222-4333-8444-555555555555';
export const GUID_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
