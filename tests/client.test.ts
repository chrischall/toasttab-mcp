import { describe, expect, it } from 'vitest';
import { GATEWAY_PATH, jwtExpiry, ToastClient, ToastEdgeBlockedError, ToastGraphqlError, ToastSignedOutError, UpstreamHttpError } from '../src/client.js';
import { GUEST_SESSION_PAGE_PATH, SESSION_PAGE_PATH } from '../src/session.js';
import { APP_SESSION_ID, fakeJwt, FakeTransport, json, SESSION_ID, sessionPage } from './fake-transport.js';

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
    await expect(new ToastClient(t).graphql('{a}')).rejects.toThrow(/order\.toasttab\.com did not render a gateway session \(HTTP 404\)/);
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
    await expect(client.graphql('{a}')).rejects.toThrow(/gateway session/);
    t.sessionPage = () => sessionPage();
    await expect(client.graphql('{a}')).resolves.toMatchObject({ data: { __typename: 'Query' } });
  });
});

describe('ToastClient.guestGraphql', () => {
  const OP = { name: 'capmanGuestApp_Test', document: 'query capmanGuestApp_Test($a: Int) { guest { id } }' };
  const ok = () => json({ data: { guest: { id: 'g' } } });

  it('sends a toast.app session, the guest app client name and the bearer, relayed by a toast.app tab', async () => {
    const t = new FakeTransport(ok);
    await new ToastClient(t).guestGraphql(OP, { a: 1 });
    expect(t.sessionRequests).toEqual([{ host: 'app', path: GUEST_SESSION_PAGE_PATH, method: 'GET' }]);
    expect(t.cookieReads).toEqual(['toast-customer-access']);
    const req = t.requests[0];
    expect(req).toMatchObject({ host: 'ws-api', relay: 'app' });
    expect(req.headers).toMatchObject({
      'apollographql-client-name': 'capman-guest-app-browser',
      'toast-session-id': APP_SESSION_ID,
      Authorization: `Bearer ${fakeJwt()}`,
    });
    const url = new URL(req.path, 'https://x.invalid');
    expect(url.searchParams.get('operationName')).toBe('capmanGuestApp_Test');
    expect(url.searchParams.get('variables')).toBe('{"a":1}');
  });

  it('keeps the two sites\' sessions apart and never sends the bearer on a public query', async () => {
    const t = new FakeTransport(ok);
    const client = new ToastClient(t);
    await client.graphql('{a}');
    await client.guestGraphql(OP);
    await client.graphql('{b}');
    expect(t.sessionRequests.map((r) => r.host)).toEqual(['order', 'app']);
    expect(t.requests.map((r) => r.headers?.['toast-session-id'])).toEqual([SESSION_ID, APP_SESSION_ID, SESSION_ID]);
    expect(t.requests[0].headers).not.toHaveProperty('Authorization');
    expect(t.requests[2].headers).not.toHaveProperty('Authorization');
  });

  it('refuses before any request when there is no toast.app sign-in', async () => {
    const t = new FakeTransport(ok);
    t.cookies = {};
    await expect(new ToastClient(t).guestGraphql(OP)).rejects.toBeInstanceOf(ToastSignedOutError);
    await expect(new ToastClient(t).guestGraphql(OP)).rejects.toThrow(/not signed in.*toast\.app/s);
    expect(t.requests).toHaveLength(0);
  });

  it('refuses an access token within a minute of expiry instead of sending it', async () => {
    const t = new FakeTransport(ok);
    t.cookies = { 'toast-customer-access': fakeJwt(2_000_000_030) };
    const client = new ToastClient(t, { now: () => 2_000_000_000_000 });
    await expect(client.guestGraphql(OP)).rejects.toThrow(/expired/);
    expect(t.requests).toHaveLength(0);
  });

  it('sends a token whose expiry cannot be read, and lets Toast judge it', async () => {
    const t = new FakeTransport(ok);
    t.cookies = { 'toast-customer-access': 'opaque-token' };
    await new ToastClient(t).guestGraphql(OP);
    expect(t.requests[0].headers?.Authorization).toBe('Bearer opaque-token');
  });

  it('turns "not permitted to call guest" into the sign-in remedy', async () => {
    const t = new FakeTransport(() =>
      json({ errors: [{ message: 'Exception while fetching data (/guest) : You are not permitted to call guest' }] }),
    );
    await expect(new ToastClient(t).guestGraphql(OP)).rejects.toBeInstanceOf(ToastSignedOutError);
  });

  it('passes other gateway errors through unchanged', async () => {
    const t = new FakeTransport(() => json({ errors: [{ message: 'Cannot query field "x"' }] }, 400));
    await expect(new ToastClient(t).guestGraphql(OP)).rejects.toBeInstanceOf(ToastGraphqlError);
  });

  it('names a toast.app page without a session', async () => {
    const t = new FakeTransport(ok);
    t.appSessionPage = () => ({ status: 404, url: 'u', body: '<html></html>' });
    await expect(new ToastClient(t).guestGraphql(OP)).rejects.toThrow(/https:\/\/toast\.app did not render a gateway session/);
  });
});

describe('jwtExpiry', () => {
  it('reads exp as epoch ms, and null for anything it cannot decode', () => {
    expect(jwtExpiry(fakeJwt(1_800_000_000))).toBe(1_800_000_000_000);
    expect(jwtExpiry('no-dots')).toBeNull();
    expect(jwtExpiry('a.!!!.c')).toBeNull();
    expect(jwtExpiry(`a.${Buffer.from('{"exp":"soon"}').toString('base64url')}.c`)).toBeNull();
  });
});
