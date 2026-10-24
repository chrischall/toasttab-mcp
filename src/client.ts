// ToastClient is the tool-facing API over a ToastTransport. Tools never see
// HTTP: they ask for a GraphQL document and get back `data` plus any partial
// errors, or a typed error that says what to do next.
import { truncateErrorMessage, UpstreamHttpError } from '@chrischall/mcp-utils';
import { classifyBotWall } from '@fetchproxy/server';
import type { GuestOperation } from './guest-documents.js';
import {
  CLIENT_NAME_HEADER,
  GATEWAY_CLIENT_NAME,
  GUEST_ACCESS_COOKIE,
  GUEST_CLIENT_NAME,
  GUEST_SESSION_PAGE_PATH,
  SESSION_HEADER,
  SESSION_PAGE_PATH,
  sessionFromFlightData,
  sessionFromPage,
  type GuestSession,
} from './session.js';
import type { FetchResult, RelaySite, ToastHost, ToastTransport } from './transport.js';

export { GUEST_ACCESS_COOKIE };


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

/**
 * The signed-in-guest path could not authenticate: no toast.app sign-in in
 * the bridged browser, or its access token has lapsed. The remedy is the
 * user's — this server never refreshes the token itself (transport-fetchproxy.ts).
 */
export class ToastSignedOutError extends Error {
  constructor(detail: string) {
    super(
      `${detail} Open https://toast.app in the browser running ContextMint Bridge and sign in (or reload the tab if you ` +
        'already are — that renews the sign-in), then retry.',
    );
    this.name = 'ToastSignedOutError';
  }
}

/** Treat an access token this close to expiry as expired. */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

/** The `exp` claim of a JWT, in epoch ms, or null if it cannot be read. */
export function jwtExpiry(token: string): number | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const exp = (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown }).exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/** How each site's tab mints the session the gateway needs (session.ts). */
const SITES: Record<RelaySite, { clientName: string; host: ToastHost; path: string; read: (html: string) => GuestSession | null; origin: string }> = {
  order: { clientName: GATEWAY_CLIENT_NAME, host: 'order', path: SESSION_PAGE_PATH, read: sessionFromPage, origin: 'https://order.toasttab.com' },
  app: { clientName: GUEST_CLIENT_NAME, host: 'app', path: GUEST_SESSION_PAGE_PATH, read: sessionFromFlightData, origin: 'https://toast.app' },
};

/** The gateway's answer when the bearer is missing, stale or not a guest's. */
const NOT_PERMITTED = /not permitted to call guest/i;

export interface ToastClientOptions {
  /** Clock for session and token expiry; tests pin it. */
  now?: () => number;
}

export class ToastClient {
  private readonly sessions: Partial<Record<RelaySite, GuestSession>> = {};
  private readonly minting: Partial<Record<RelaySite, Promise<GuestSession>>> = {};
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
   * Run a GraphQL document against the gateway over GET, under an
   * order.toasttab.com session (see session.ts for why both headers are
   * required). Public data only: no account is attached.
   *
   * GET, not POST: the gateway answers either once the headers are right, and
   * GET keeps every request visibly a read to anything in between. A
   * "Forbidden" answer drops the cached session and retries once with a fresh
   * one — the usual cause is a session Toast expired early.
   */
  async graphql<T = Record<string, unknown>>(document: string, opts: GraphqlOptions = {}): Promise<GraphqlResult<T>> {
    return this.run<T>('order', document, opts, {});
  }

  /**
   * Run one of Toast's guest-app queries (guest-documents.ts) as the user
   * signed in to toast.app in the bridged browser: a toast.app session plus
   * their access token, read from the browser for this call only.
   */
  async guestGraphql<T = Record<string, unknown>>(
    op: GuestOperation,
    variables?: Record<string, unknown>,
  ): Promise<GraphqlResult<T>> {
    const token = await this.transport.readAppCookie?.(GUEST_ACCESS_COOKIE);
    if (!token) throw new ToastSignedOutError('You are not signed in to Toast in the bridged browser.');
    const exp = jwtExpiry(token);
    if (exp !== null && exp - TOKEN_EXPIRY_MARGIN_MS <= this.now()) {
      throw new ToastSignedOutError('Your toast.app sign-in has expired.');
    }
    try {
      return await this.run<T>('app', op.document, { variables, operationName: op.name }, { Authorization: `Bearer ${token}` });
    } catch (e) {
      if (e instanceof ToastGraphqlError && e.errors.some((x) => NOT_PERMITTED.test(x.message))) {
        throw new ToastSignedOutError('Toast did not accept your toast.app sign-in.');
      }
      throw e;
    }
  }

  private async run<T>(
    site: RelaySite,
    document: string,
    opts: GraphqlOptions,
    extraHeaders: Record<string, string>,
  ): Promise<GraphqlResult<T>> {
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
        relay: site,
        headers: {
          Accept: 'application/json',
          [CLIENT_NAME_HEADER]: SITES[site].clientName,
          [SESSION_HEADER]: session.id,
          ...extraHeaders,
        },
      });
    let result = await send(await this.session(site));
    if (isForbidden(result)) {
      delete this.sessions[site];
      result = await send(await this.session(site));
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
   * The cached session for `site`, minted from one of its pages when missing
   * or near expiry. Concurrent callers share one mint.
   */
  private async session(site: RelaySite): Promise<GuestSession> {
    const cached = this.sessions[site];
    if (cached && cached.expiresAt - SESSION_REFRESH_MARGIN_MS > this.now()) return cached;
    this.minting[site] ??= this.mintSession(site).finally(() => {
      delete this.minting[site];
    });
    return this.minting[site];
  }

  private async mintSession(site: RelaySite): Promise<GuestSession> {
    const { host, path, read, origin } = SITES[site];
    const result = await this.transport.fetch({ host, path, method: 'GET' });
    this.throwIfEdgeBlocked(result, `${origin}${path}`);
    // The path 404s by design; any status is fine as long as the page rendered a session.
    const session = read(result.body);
    if (!session) {
      throw new UpstreamHttpError(
        result.status,
        `${origin} did not render a gateway session (HTTP ${result.status}), so Toast's GraphQL gateway cannot be reached. ` +
          `Toast may have changed how its web app starts a session; open ${site === 'order' ? 'https://order.toasttab.com/online/<any-restaurant>' : 'https://toast.app'} in the bridged browser and retry.`,
      );
    }
    this.sessions[site] = session;
    return session;
  }

  private throwIfEdgeBlocked(result: FetchResult, what: string): void {
    const wall = classifyBotWall(result.body, result.status);
    if (wall.blocked) throw new ToastEdgeBlockedError(wall.vendor, what);
  }
}
