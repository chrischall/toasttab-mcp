// ToastClient is the tool-facing API over a ToastTransport. Tools never see
// HTTP: they ask for a GraphQL document and get back `data` plus any partial
// errors, or a typed error that says what to do next.
import { truncateErrorMessage, UpstreamHttpError } from '@chrischall/mcp-utils';
import { classifyBotWall } from '@fetchproxy/server';
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
        ? 'Toast\'s GraphQL gateway answered "Forbidden". It refuses requests that do not come from a ' +
            'browser that has passed its edge check: open https://order.toasttab.com in the bridged ' +
            'browser (any restaurant page), let it load, then retry.'
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

export class ToastClient {
  constructor(private readonly transport: ToastTransport) {}

  start(): Promise<void> {
    return this.transport.start();
  }

  close(): Promise<void> {
    return this.transport.close();
  }

  /**
   * Run a GraphQL document against the gateway over GET.
   *
   * GET, not POST: the gateway refuses POST from outside Toast's own origin
   * and answers the query in the query string (the third-party collector this
   * repo's queries come from found the same). It also means a read can never
   * be mistaken for a write by anything in between.
   */
  async graphql<T = Record<string, unknown>>(document: string, opts: GraphqlOptions = {}): Promise<GraphqlResult<T>> {
    const params = new URLSearchParams({ query: document });
    if (opts.variables && Object.keys(opts.variables).length > 0) {
      params.set('variables', JSON.stringify(opts.variables));
    }
    if (opts.operationName) params.set('operationName', opts.operationName);
    const path = `${GATEWAY_PATH}?${params.toString()}`;
    const result = await this.transport.fetch({
      host: 'ws-api',
      path,
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
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
