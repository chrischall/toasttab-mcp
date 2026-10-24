import { describe, expect, it } from 'vitest';
import { GATEWAY_PATH, ToastClient, ToastEdgeBlockedError, ToastGraphqlError, UpstreamHttpError } from '../src/client.js';
import { FakeTransport, json } from './fake-transport.js';

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

describe('ToastClient.fetchText', () => {
  it('returns 2xx bodies and throws on others', async () => {
    const ok = new FakeTransport(() => ({ status: 200, url: 'u', body: 'hello' }));
    expect(await new ToastClient(ok).fetchText('order', '/online/x')).toBe('hello');
    expect(ok.requests[0]).toMatchObject({ host: 'order', path: '/online/x' });
    const nf = new FakeTransport(() => ({ status: 404, url: 'u', body: 'nope' }));
    await expect(new ToastClient(nf).fetchText('order', '/online/x')).rejects.toThrow(/HTTP 404/);
  });
});
