import { afterEach, describe, expect, it } from 'vitest';
import { ToastClient } from '../../src/client.js';
import { registerMenuTools } from '../../src/tools/menus.js';
import { createTestHarness, parseToolResult, type TestHarness } from '../helpers.js';
import { FakeTransport, GUID_A, json } from '../fake-transport.js';

const menus = (items: unknown[]) => ({
  data: { menusV3: { __typename: 'MenusResponse', menus: [{ name: 'Main', groups: [{ name: 'Coffee', items }] }] } },
});
const ONLINE = [{ guid: 'i1', name: 'Latte', description: 'Espresso and milk', price: 4.5, prices: [], outOfStock: false }];
const POS = [...ONLINE, { guid: 'i2', name: 'Drip', description: null, price: null, prices: [2, 3], outOfStock: true }];

let h: TestHarness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

async function call(t: FakeTransport, args: Record<string, unknown>) {
  h = await createTestHarness((server) => registerMenuTools(server, new ToastClient(t)));
  return h.callTool('toast_get_menu', args);
}

describe('toast_get_menu', () => {
  it('reads the online menu by default', async () => {
    const t = new FakeTransport(() => json(menus(ONLINE)));
    const res = parseToolResult<Record<string, unknown>>(await call(t, { restaurant: GUID_A }));
    expect(res).toMatchObject({ guid: GUID_A, source: 'online', total_items: 1, returned: 1, truncated: false });
    expect(t.queries).toHaveLength(1);
    expect(t.queries[0]).toContain(`restaurantGuid:"${GUID_A}"`);
    expect(t.queries[0]).not.toContain('visibility');
  });

  it('merges online + POS for both', async () => {
    const t = new FakeTransport((_, q) => json(menus(q?.includes('visibility:POS') ? POS : ONLINE)));
    const res = parseToolResult<{ total_items: number; menus: Array<{ groups: Array<{ items: Array<{ guid: string; sources: string[] }> }> }> }>(
      await call(t, { restaurant: `https://toast.app/r/x/order/r-${GUID_A}`, source: 'both' }),
    );
    expect(res.total_items).toBe(2);
    const all = res.menus.flatMap((m) => m.groups.flatMap((g) => g.items));
    expect(all.find((i) => i.guid === 'i1')?.sources).toEqual(['online', 'pos']);
    expect(all.find((i) => i.guid === 'i2')?.sources).toEqual(['pos']);
  });

  it('applies query, stock filter and limit with an honest note', async () => {
    const t = new FakeTransport(() => json(menus(POS)));
    const res = parseToolResult<Record<string, unknown>>(await call(t, { restaurant: GUID_A, source: 'pos', include_out_of_stock: false }));
    expect(res).toMatchObject({ total_items: 1, out_of_stock_hidden: 1 });
    const capped = parseToolResult<Record<string, unknown>>(await call(new FakeTransport(() => json(menus(POS))), { restaurant: GUID_A, limit: 1 }));
    expect(capped).toMatchObject({ truncated: true, returned: 1, total_items: 2 });
    expect(capped.note).toMatch(/Showing 1 of 2/);
  });

  it('warns instead of inventing a menu when Toast answers with another union arm', async () => {
    const t = new FakeTransport(() => json({ data: { menusV3: { __typename: 'MenusErrorResponse' } } }));
    const res = parseToolResult<{ total_items: number; warnings: string[] }>(await call(t, { restaurant: GUID_A }));
    expect(res.total_items).toBe(0);
    expect(res.warnings[0]).toMatch(/MenusErrorResponse/);
  });

  it('view full returns raw data per source', async () => {
    const t = new FakeTransport(() => json(menus(ONLINE)));
    const res = parseToolResult<{ data: Record<string, unknown> }>(await call(t, { restaurant: GUID_A, view: 'full' }));
    expect(Object.keys(res.data)).toEqual(['online']);
  });

  it('refuses a reference without a GUID before any request', async () => {
    const t = new FakeTransport(() => json(menus(ONLINE)));
    const res = await call(t, { restaurant: 'joes-pizza' });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/toast_resolve_restaurant/);
    expect(t.requests).toHaveLength(0);
  });
});
