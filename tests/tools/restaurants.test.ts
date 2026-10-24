import { afterEach, describe, expect, it } from 'vitest';
import { ToastClient } from '../../src/client.js';
import { registerRestaurantTools } from '../../src/tools/restaurants.js';
import { createTestHarness, parseToolResult, type TestHarness } from '../helpers.js';
import { FakeTransport, GUID_A, GUID_B, json } from '../fake-transport.js';

const ROWS = [
  { guid: GUID_B, name: 'Far Cafe', shortUrl: 'far-cafe', location: { address1: '9 Elm', city: 'Charlotte', state: 'NC', latitude: 35.25, longitude: -80.8 } },
  { guid: GUID_A, name: "Joe's Pizza", shortUrl: 'joes-pizza', location: { address1: '1 Main', city: 'Charlotte', state: 'NC', latitude: 35.228, longitude: -80.843 } },
];

let h: TestHarness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

async function harness(t: FakeTransport) {
  h = await createTestHarness((server) => registerRestaurantTools(server, new ToastClient(t)));
  return h;
}

describe('toast_find_restaurants', () => {
  it('queries the directory and returns restaurants nearest first', async () => {
    const t = new FakeTransport(() => json({ data: { nearbyRestaurants: ROWS } }));
    const res = parseToolResult<{ total: number; restaurants: Array<{ name: string }> }>(
      await (await harness(t)).callTool('toast_find_restaurants', { latitude: 35.2271, longitude: -80.8431, when: '2026-10-24T12:00:00-04:00' }),
    );
    expect(res.total).toBe(2);
    expect(res.restaurants.map((r) => r.name)).toEqual(["Joe's Pizza", 'Far Cafe']);
    expect(t.queries[0]).toContain('fulfillmentDateTime:"2026-10-24T16:00:00.000Z"');
    expect(t.queries[0]).toContain('radius:2');
  });

  it('filters by name and limit, and passes partial errors through as warnings', async () => {
    const t = new FakeTransport(() => json({ data: { nearbyRestaurants: ROWS }, errors: [{ message: 'one shard down' }] }));
    const res = parseToolResult<Record<string, unknown>>(
      await (await harness(t)).callTool('toast_find_restaurants', { latitude: 35.2, longitude: -80.8, name: 'cafe', limit: 1 }),
    );
    expect(res).toMatchObject({ total: 1, returned: 1, warnings: ['one shard down'] });
  });

  it('warns when the 299-row cap was hit', async () => {
    const many = Array.from({ length: 299 }, (_, i) => ({ ...ROWS[0], guid: `g${i}` }));
    const t = new FakeTransport(() => json({ data: { nearbyRestaurants: many } }));
    const res = parseToolResult<{ note?: string }>(await (await harness(t)).callTool('toast_find_restaurants', { latitude: 35, longitude: -80 }));
    expect(res.note).toMatch(/299-row maximum/);
  });

  it('view full returns the raw data', async () => {
    const t = new FakeTransport(() => json({ data: { nearbyRestaurants: ROWS } }));
    const res = parseToolResult<{ data: unknown }>(await (await harness(t)).callTool('toast_find_restaurants', { latitude: 35, longitude: -80, view: 'full' }));
    expect(res.data).toEqual({ nearbyRestaurants: ROWS });
  });

  it('rejects an unparseable when', async () => {
    const t = new FakeTransport(() => json({ data: {} }));
    const res = await (await harness(t)).callTool('toast_find_restaurants', { latitude: 35, longitude: -80, when: 'tomorrow-ish' });
    expect(res.isError).toBe(true);
    expect(t.requests).toHaveLength(0);
  });
});

describe('toast_resolve_restaurant', () => {
  it('needs no network when the reference carries a GUID', async () => {
    const t = new FakeTransport(() => { throw new Error('no network expected'); });
    const res = parseToolResult(await (await harness(t)).callTool('toast_resolve_restaurant', { reference: `https://toast.app/r/x/order/r-${GUID_A}` }));
    expect(res).toEqual({ guid: GUID_A, short_url: null, resolved_by: 'reference' });
  });

  it('finds a shortUrl in the directory near a point', async () => {
    const t = new FakeTransport(() => json({ data: { nearbyRestaurants: ROWS } }));
    const res = parseToolResult<{ guid: string; resolved_by: string }>(
      await (await harness(t)).callTool('toast_resolve_restaurant', { reference: 'https://order.toasttab.com/online/joes-pizza', latitude: 35.2271, longitude: -80.8431 }),
    );
    expect(res).toMatchObject({ guid: GUID_A, resolved_by: 'directory' });
    expect(t.requests).toHaveLength(1);
  });

  it('retries the directory 12h later, then falls back to the ordering page', async () => {
    const t = new FakeTransport((init) =>
      init.host === 'order'
        ? { status: 200, url: 'u', body: `<script>window.__S={"restaurantGuid":"${GUID_A}"}</script>` }
        : json({ data: { nearbyRestaurants: [] } }),
    );
    const res = parseToolResult<{ guid: string; resolved_by: string }>(
      await (await harness(t)).callTool('toast_resolve_restaurant', { reference: 'joes-pizza', latitude: 35, longitude: -80 }),
    );
    expect(res).toMatchObject({ guid: GUID_A, resolved_by: 'ordering_page' });
    expect(t.requests.map((r) => r.host)).toEqual(['ws-api', 'ws-api', 'order']);
    expect(t.requests[2].path).toBe('/online/joes-pizza');
  });

  it('says what to do when nothing resolves', async () => {
    const t = new FakeTransport(() => ({ status: 200, url: 'u', body: '<html></html>' }));
    const res = parseToolResult<{ guid: null; next_step: string }>(
      await (await harness(t)).callTool('toast_resolve_restaurant', { reference: 'joes-pizza' }),
    );
    expect(res.guid).toBeNull();
    expect(res.next_step).toMatch(/latitude\/longitude/);
  });
});
