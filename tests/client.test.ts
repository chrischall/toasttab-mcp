import { describe, expect, it } from 'vitest';
import { GATEWAY_PATH, ToastClient, ToastEdgeBlockedError, ToastGraphqlError, UpstreamHttpError } from '../src/client.js';
import { SESSION_PAGE_PATH } from '../src/session.js';
import { FakeTransport, json, SESSION_ID, sessionPage } from './fake-transport.js';

describe('ToastClient.graphql', () => {
  it('sends a GET to the gateway on ws-api with the document in the query string', async () => {
    const t = new FakeTransport(() => json({ data: { __typename: 'Query' } }));
    const res = await new ToastClient(t).graphql('{__typename}', { variables: { a: 1 }, operationName: 'Op' });
    expect(res).toEqual({ data: { __typename: 'Query' }, errors: [] });
    const req = t.requests[0];
    expect(req).toMatchObject({ host: 'ws-api', method: 'GET' });
    const url = new URL(req.path, 'https://x.invalid');
    expect(url.pathname).toBe(GATEWAY_PATH);
    expect(url.searchParams.get('query')).toBe('{__typename}');
    expect(url.searchParams.get('variables')).toBe('{"a":1}');
    expect(url.searchParams.get('operationName')).toBe('Op');
  });

  it('omits empty variables', async () => {
    const t = new FakeTransport(() => json({ data: {} }));
    await new ToastClient(t).graphql('{a}', { variables: {} });
    expect(new URL(t.requests[0].path, 'https://x.invalid').searchParams.has('variables')).toBe(false);
  });

  it('returns partial data with its errors', async () => {
    const t = new FakeTransport(() => json({ data: { a: 1 }, errors: [{ message: 'b failed' }] }));
    expect(await new ToastClient(t).graphql('{a b}')).toEqual({ data: { a: 1 }, errors: [{ message: 'b failed' }] });
  });

  it('turns the gateway\'s bare "Forbidden" into a remedy', async () => {
    const t = new FakeTransport(() => json({ errors: [{ message: 'Forbidden' }] }));
    await expect(new ToastClient(t).graphql('{a}')).rejects.toThrow(/order\.toasttab\.com/);
    await expect(new ToastClient(t).graphql('{a}')).rejects.toBeInstanceOf(ToastGraphqlError);
  });

  it('surfaces validation errors verbatim', async () => {
    const t = new FakeTransport(() => json({ errors: [{ message: 'Cannot query field "x" on type "Query".' }] }, 400));
    await expect(new ToastClient(t).graphql('{x}')).rejects.toThrow(/Cannot query field "x"/);
  });

  it('names a Cloudflare challenge as a block, not an empty result', async () => {
    const t = new FakeTransport(() => ({
      status: 403,
      url: 'https://ws-api.toasttab.com/x',
      body: '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><div id="challenge-platform"></div><script src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></body></html>',
    }));
    await expect(new ToastClient(t).graphql('{a}')).rejects.toBeInstanceOf(ToastEdgeBlockedError);
  });

  it('reports non-JSON and data-less answers with the HTTP status', async () => {
    const html = new FakeTransport(() => ({ status: 502, url: 'u', body: '<html>bad gateway</html>' }));
    await expect(new ToastClient(html).graphql('{a}')).rejects.toBeInstanceOf(UpstreamHttpError);
    const empty = new FakeTransport(() => json({}));
    await expect(new ToastClient(empty).graphql('{a}')).rejects.toThrow(/no data/);
  });
});

describe('ToastClient guest session', () => {
  const ok = () => json({ data: { __typename: 'Query' } });
  const forbidden = () => json({ errors: [{ message: 'Forbidden' }] }, 403);

  it('mints a session from the ordering page and sends it with the SPA client name', async () => {
    const t = new FakeTransport(ok);
    await new ToastClient(t).graphql('{a}');
    expect(t.sessionRequests).toEqual([{ host: 'order', path: SESSION_PAGE_PATH, method: 'GET' }]);
    expect(t.requests[0].headers).toMatchObject({
      'apollographql-client-name': 'sites-web-client',
      'toast-session-id': SESSION_ID,
    });
  });

  it('reuses the session across calls and shares one mint between concurrent calls', async () => {
    const t = new FakeTransport(ok);
    const client = new ToastClient(t);
    await Promise.all([client.graphql('{a}'), client.graphql('{b}')]);
    await client.graphql('{c}');
    expect(t.sessionRequests).toHaveLength(1);
  });

  it('re-mints when the session is within five minutes of expiry', async () => {
    const t = new FakeTransport(ok);
    t.sessionPage = () => sessionPage('first', '2030-01-01T01:00:00Z');
    let now = Date.parse('2030-01-01T00:00:00Z');
    const client = new ToastClient(t, { now: () => now });
    await client.graphql('{a}');
    now = Date.parse('2030-01-01T00:54:00Z');
    await client.graphql('{a}');
    expect(t.sessionRequests).toHaveLength(1);
    now = Date.parse('2030-01-01T00:56:00Z');
    t.sessionPage = () => sessionPage('second', '2030-01-01T02:00:00Z');
    await client.graphql('{a}');
    expect(t.sessionRequests).toHaveLength(2);
    expect(t.requests.at(-1)?.headers?.['toast-session-id']).toBe('second');
  });

  it('drops a session the gateway calls Forbidden and retries once with a fresh one', async () => {
    let calls = 0;
    const t = new FakeTransport(() => (++calls === 1 ? forbidden() : ok()));
    let n = 0;
    t.sessionPage = () => sessionPage(`s${++n}`);
    expect(await new ToastClient(t).graphql('{__typename}')).toEqual({ data: { __typename: 'Query' }, errors: [] });
    expect(t.requests.map((r) => r.headers?.['toast-session-id'])).toEqual(['s1', 's2']);
  });

  it('gives up after one fresh session is also Forbidden', async () => {
    const t = new FakeTransport(forbidden);
    await expect(new ToastClient(t).graphql('{a}')).rejects.toBeInstanceOf(ToastGraphqlError);
    expect(t.requests).toHaveLength(2);
  });

  it('names a page without a session, and an edge block on the session page', async () => {
    const t = new FakeTransport(ok);
    t.sessionPage = () => ({ status: 404, url: 'u', body: '<html></html>' });
    await expect(new ToastClient(t).graphql('{a}')).rejects.toThrow(/did not carry a guest session \(HTTP 404\)/);
    expect(t.requests).toHaveLength(0);

    t.sessionPage = () => ({
      status: 403,
      url: 'u',
      body: '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><div id="challenge-platform"></div><script src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></body></html>',
    });
    await expect(new ToastClient(t).graphql('{a}')).rejects.toBeInstanceOf(ToastEdgeBlockedError);
  });

  it('lets a failed mint be retried by the next call', async () => {
    const t = new FakeTransport(ok);
    t.sessionPage = () => ({ status: 500, url: 'u', body: '' });
    const client = new ToastClient(t);
    await expect(client.graphql('{a}')).rejects.toThrow(/guest session/);
    t.sessionPage = () => sessionPage();
    await expect(client.graphql('{a}')).resolves.toMatchObject({ data: { __typename: 'Query' } });
  });
});

describe('ToastClient.fetchText', () => {
  it('returns 2xx bodies and throws on others', async () => {
    const ok = new FakeTransport(() => ({ status: 200, url: 'u', body: 'hello' }));
    expect(await new ToastClient(ok).fetchText('order', '/online/x')).toBe('hello');
    expect(ok.requests[0]).toMatchObject({ host: 'order', path: '/online/x' });
    const nf = new FakeTransport(() => ({ status: 404, url: 'u', body: 'nope' }));
    await expect(new ToastClient(nf).fetchText('order', '/online/x')).rejects.toThrow(/HTTP 404/);
  });
});
