// ToastClient is the tool-facing API over a ToastTransport. Tools never see
// HTTP: they ask for a GraphQL document and get back `data` plus any partial
// errors, or a typed error that says what to do next.
import { truncateErrorMessage, UpstreamHttpError } from '@chrischall/mcp-utils';
import { classifyBotWall } from '@fetchproxy/server';
import {
  CLIENT_NAME_HEADER,
  GATEWAY_CLIENT_NAME,
  SESSION_HEADER,
  SESSION_PAGE_PATH,
  sessionFromPage,
  type GuestSession,
} from './session.js';
import type { FetchResult, ToastHost, ToastTransport } from './transport.js';

export { UpstreamHttpError };

/** The online-ordering GraphQL gateway, on ws-api.toasttab.com. */
export const GATEWAY_PATH = '/do-federated-gateway/v1/graphql';

/**
 * Cloudflare (or another edge) answered instead of Toast. From the browser
 * this almost always means the bridged tab has not passed the site's check
 * yet, so the remedy is the user's, not a retry loop's.
 */
export class ToastEdgeBlockedError extends Error {
  constructor(readonly vendor: string, what: string) {
    super(
      `Toast's edge (${vendor}) refused ${what} before Toast saw it. Open https://order.toasttab.com ` +
        'in the browser running the ContextMint Bridge extension, complete any "verify you are human" ' +
        'check, then retry once. This is a block, not an empty result.',
    );
    this.name = 'ToastEdgeBlockedError';
  }
}

export interface GraphqlError {
  message: string;
  path?: unknown;
  extensions?: unknown;
}

/** The gateway answered with errors and no data. */
export class ToastGraphqlError extends Error {
  constructor(readonly errors: GraphqlError[]) {
    super(
      errors.some((e) => e.message === 'Forbidden')
        ? 'Toast\'s GraphQL gateway answered "Forbidden" even with a freshly minted guest session. ' +
            'Toast may have changed what it requires of the online-ordering client; open any ' +
            'https://order.toasttab.com/online/<restaurant> page in the bridged browser, let it load, then retry once.'
        : `Toast GraphQL error: ${truncateErrorMessage(errors.map((e) => e.message).join('; '))}`,
    );
    this.name = 'ToastGraphqlError';
  }
}

export interface GraphqlResult<T> {
  data: T;
  /** Errors the gateway reported alongside partial data. Empty when clean. */
  errors: GraphqlError[];
}

export interface GraphqlOptions {
  variables?: Record<string, unknown>;
  operationName?: string;
}

/** Re-mint this long before Toast's stated expiry, so a request never races it. */
const SESSION_REFRESH_MARGIN_MS = 5 * 60_000;

/** The gateway's answer to a request without a valid guest session. */
function isForbidden(result: FetchResult): boolean {
  if (result.status !== 403) return false;
  try {
    const errors = (JSON.parse(result.body) as { errors?: GraphqlError[] }).errors;
    return Array.isArray(errors) && errors.some((e) => e.message === 'Forbidden');
  } catch {
    return false;
  }
}

export interface ToastClientOptions {
  /** Clock for session expiry; tests pin it. */
  now?: () => number;
}

export class ToastClient {
  private session: GuestSession | null = null;
  private minting: Promise<GuestSession> | null = null;
  private readonly now: () => number;

  constructor(private readonly transport: ToastTransport, opts: ToastClientOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  start(): Promise<void> {
    return this.transport.start();
  }

  close(): Promise<void> {
    return this.transport.close();
  }

  /**
   * Run a GraphQL document against the gateway over GET, under a guest
   * session (see session.ts for why both headers are required).
   *
   * GET, not POST: the gateway answers either once the headers are right, and
   * GET keeps every request visibly a read to anything in between. A
   * "Forbidden" answer drops the cached session and retries once with a fresh
   * one — the usual cause is a session Toast expired early.
   */
  async graphql<T = Record<string, unknown>>(document: string, opts: GraphqlOptions = {}): Promise<GraphqlResult<T>> {
    const params = new URLSearchParams({ query: document });
    if (opts.variables && Object.keys(opts.variables).length > 0) {
      params.set('variables', JSON.stringify(opts.variables));
    }
    if (opts.operationName) params.set('operationName', opts.operationName);
    const path = `${GATEWAY_PATH}?${params.toString()}`;
    const send = async (session: GuestSession) =>
      this.transport.fetch({
        host: 'ws-api',
        path,
        method: 'GET',
        headers: {
          Accept: 'application/json',
          [CLIENT_NAME_HEADER]: GATEWAY_CLIENT_NAME,
          [SESSION_HEADER]: session.id,
        },
      });
    let result = await send(await this.guestSession());
    if (isForbidden(result)) {
      this.session = null;
      result = await send(await this.guestSession());
    }
    this.throwIfEdgeBlocked(result, 'the GraphQL request');

    let payload: { data?: T | null; errors?: GraphqlError[] };
    try {
      payload = JSON.parse(result.body) as typeof payload;
    } catch {
      throw new UpstreamHttpError(
        result.status,
        `Toast gateway returned non-JSON (HTTP ${result.status}): ${truncateErrorMessage(result.body.replace(/\s+/g, ' ').trim())}`,
      );
    }
    const errors = Array.isArray(payload.errors) ? payload.errors : [];
    if (payload.data === undefined || payload.data === null) {
      if (errors.length > 0) throw new ToastGraphqlError(errors);
      throw new UpstreamHttpError(result.status, `Toast gateway returned no data (HTTP ${result.status}).`);
    }
    return { data: payload.data, errors };
  }

  /**
   * The cached guest session, minted from an order.toasttab.com page when it
   * is missing or near expiry. Concurrent callers share one mint.
   */
  private async guestSession(): Promise<GuestSession> {
    if (this.session && this.session.expiresAt - SESSION_REFRESH_MARGIN_MS > this.now()) return this.session;
    this.minting ??= this.mintSession().finally(() => {
      this.minting = null;
    });
    return this.minting;
  }

  private async mintSession(): Promise<GuestSession> {
    const result = await this.transport.fetch({ host: 'order', path: SESSION_PAGE_PATH, method: 'GET' });
    this.throwIfEdgeBlocked(result, `https://order.toasttab.com${SESSION_PAGE_PATH}`);
    // The path 404s by design; any status is fine as long as the page rendered a session.
    const session = sessionFromPage(result.body);
    if (!session) {
      throw new UpstreamHttpError(
        result.status,
        `Toast's ordering page did not carry a guest session (HTTP ${result.status}), so the GraphQL gateway cannot be reached. ` +
          'Toast may have changed how online ordering starts a session; open https://order.toasttab.com/online/<any-restaurant> in the bridged browser and retry.',
      );
    }
    this.session = session;
    return session;
  }

  /** GET a page on a toasttab.com host and return its body. */
  async fetchText(host: ToastHost, path: string): Promise<string> {
    const result = await this.transport.fetch({ host, path, method: 'GET' });
    this.throwIfEdgeBlocked(result, `https://${host}.toasttab.com${path}`);
    if (result.status < 200 || result.status >= 300) {
      throw new UpstreamHttpError(result.status, `Toast returned HTTP ${result.status} for https://${host}.toasttab.com${path}`);
    }
    return result.body;
  }

  private throwIfEdgeBlocked(result: FetchResult, what: string): void {
    const wall = classifyBotWall(result.body, result.status);
    if (wall.blocked) throw new ToastEdgeBlockedError(wall.vendor, what);
  }
}
