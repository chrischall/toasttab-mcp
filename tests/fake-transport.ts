// An in-memory ToastTransport: records every request and answers from a
// handler, so tests drive the REAL ToastClient (path building, error mapping).
// Payloads here are synthetic, shaped after the third-party collector cited in
// src/graphql.ts — not live captures.
import type { FetchInit, FetchResult, ToastTransport } from '../src/transport.js';

export type Handler = (init: FetchInit, query: string | null) => FetchResult | Promise<FetchResult>;

export class FakeTransport implements ToastTransport {
  readonly requests: FetchInit[] = [];
  constructor(public handler: Handler) {}
  async start(): Promise<void> {}
  async close(): Promise<void> {}
  async fetch(init: FetchInit): Promise<FetchResult> {
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
