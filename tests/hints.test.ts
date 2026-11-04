import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { ToastClient } from '../src/client.js';
import type { ToastTransport } from '../src/transport.js';
import { registerRestaurantTools } from '../src/tools/restaurants.js';
import { registerMenuTools } from '../src/tools/menus.js';
import { registerGraphqlTools } from '../src/tools/graphql.js';
import { registerAccountTools } from '../src/tools/account.js';
import { registerHealthcheckTools } from '../src/tools/healthcheck.js';
import { createTestHarness, type TestHarness } from './helpers.js';
import { FakeTransport, json } from './fake-transport.js';

/**
 * Context-group hints (`_meta.mint`, the mcp-host context-groups contract),
 * read off `tools/list` — what a host sees.
 */
type Listed = {
  name: string;
  inputSchema: { properties?: Record<string, Record<string, unknown>> };
  annotations?: { readOnlyHint?: boolean };
  _meta?: { mint?: Record<string, unknown> };
};

const DOMAINS = ['school', 'home', 'work', 'family', 'health', 'money', 'travel', 'food'];
const INTENTS = ['whats-new', 'whats-due', 'whats-on', 'lookup', 'turn-on-off', 'send', 'change', 'other'];
const CANONICAL_INTENTS = ['whats-new', 'whats-due', 'whats-on'];
const KEYS = ['domain', 'intent', 'canonical', 'subject', 'when', 'aliases'];

/** The intent every tool declares — this table is the assertion. */
const EXPECTED_INTENT: Record<string, string> = {
  toast_find_restaurants: 'lookup',
  toast_resolve_restaurant: 'lookup',
  toast_get_menu: 'lookup',
  toast_graphql: 'other',
  toast_list_orders: 'whats-new',
  toast_get_order: 'lookup',
  toast_get_loyalty: 'lookup',
  toast_get_wallet: 'lookup',
};

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/guest/${name}.json`, import.meta.url), 'utf8')) as { data: unknown };

let h: TestHarness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

async function harness(t: FakeTransport = new FakeTransport(() => json({ data: {} }))) {
  const client = new ToastClient(t);
  const bridged = Object.assign(t, { runProbe: async () => undefined, bridgeStatus: () => undefined }) as unknown as ToastTransport;
  h = await createTestHarness((server) => {
    registerRestaurantTools(server, client);
    registerMenuTools(server, client);
    registerGraphqlTools(server, client);
    registerAccountTools(server, client);
    registerHealthcheckTools(server, client, bridged);
  });
  return h;
}

async function served(): Promise<Listed[]> {
  const { tools } = await (await harness()).client.listTools();
  return tools as Listed[];
}

describe('_meta.mint on tools/list', () => {
  it('names every served tool, so a new tool cannot skip the decision', async () => {
    const names = (await served()).map((t) => t.name).filter((n) => n !== 'toast_healthcheck');
    expect(names.sort()).toEqual(Object.keys(EXPECTED_INTENT).sort());
  });

  it('leaves only the mcp-utils healthcheck unhinted', async () => {
    const unhinted = (await served()).filter((t) => !t._meta?.mint).map((t) => t.name);
    expect(unhinted).toEqual(['toast_healthcheck']);
  });

  it.each(Object.entries(EXPECTED_INTENT))('%s declares domain food and intent %s', async (name, intent) => {
    const mint = (await served()).find((t) => t.name === name)?._meta?.mint;
    expect(mint).toBeDefined();
    expect(mint!.domain).toBe('food');
    expect(mint!.intent).toBe(intent);
  });

  it('every hint is shaped per the host contract', async () => {
    for (const t of await served()) {
      const mint = t._meta?.mint;
      if (!mint) continue;
      const props = t.inputSchema.properties ?? {};
      expect(Object.keys(mint).filter((k) => !KEYS.includes(k)), t.name).toEqual([]);
      expect(DOMAINS, t.name).toContain(mint.domain);
      expect(INTENTS, t.name).toContain(mint.intent);
      if ('canonical' in mint) {
        expect(mint.canonical, t.name).toBe(true);
        expect(t.annotations?.readOnlyHint, t.name).toBe(true);
        expect(CANONICAL_INTENTS, t.name).toContain(mint.intent);
      }
      if ('subject' in mint) expect(props, t.name).toHaveProperty(mint.subject as string);
      if ('when' in mint) {
        const when = mint.when as Record<string, string>;
        expect(Object.keys(when).sort(), t.name).toEqual(['end', 'start']);
        expect(props, t.name).toHaveProperty(when.start);
        expect(props, t.name).toHaveProperty(when.end);
      }
      if ('aliases' in mint) {
        const aliases = mint.aliases as string[];
        expect(aliases.length, t.name).toBeLessThanOrEqual(8);
        for (const a of aliases) {
          expect(a.length, t.name).toBeLessThanOrEqual(40);
          expect(a, t.name).toBe(a.toLowerCase());
        }
      }
    }
  });

  it('marks at most one canonical read per what’s-new/due/on: the order history for whats-new', async () => {
    const canonical = (await served())
      .filter((t) => t._meta?.mint?.canonical === true)
      .map((t) => [t.name, t._meta!.mint!.intent]);
    expect(canonical).toEqual([['toast_list_orders', 'whats-new']]);
    for (const intent of CANONICAL_INTENTS) {
      expect(canonical.filter(([, i]) => i === intent).length, intent).toBeLessThanOrEqual(1);
    }
  });

  it('the order history names no subject (one signed-in account) and no range (Toast pages by token)', async () => {
    const orders = (await served()).find((t) => t.name === 'toast_list_orders')!;
    expect(orders._meta?.mint).toEqual({
      domain: 'food',
      intent: 'whats-new',
      canonical: true,
      aliases: ['takeout', 'my order', 'food order', 'pickup', 'delivery', 'toast'],
    });
  });

  it('a canonical read offers view "brief"', async () => {
    for (const t of (await served()).filter((x) => x._meta?.mint?.canonical === true)) {
      expect(t.inputSchema.properties?.view?.enum, t.name).toContain('brief');
    }
  });
});

describe('toast_list_orders view "brief"', () => {
  const LINE = /^.+ — (\d{4}-\d{2}-\d{2}T[\d:.]+Z|no date) — .+$/;

  it('answers one line per order: title — ISO date — status, each ≤ 120 chars', async () => {
    const t = new FakeTransport(() => json(fixture('GetGuestOrderHistory')));
    const res = await (await harness(t)).client.callTool({ name: 'toast_list_orders', arguments: { view: 'brief' } });
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    const lines = text.split('\n');
    expect(lines).toEqual([
      `name-3 (take out, 6 items) — ${new Date(1768501800000).toISOString()} — ready for pickup`,
      `name-8 (dine in, 11 items) — ${new Date(1768501800000).toISOString()} — ready for pickup`,
    ]);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(120);
      expect(line).toMatch(LINE);
    }
  });

  it('says "no date" and shortens a long restaurant name to keep the line ≤ 120', async () => {
    const long = 'R'.repeat(200);
    const t = new FakeTransport(() =>
      json({ data: { orderHistory: { nextPageToken: null, orders: [{ guid: 'x', restaurant: { name: long } }] } } }),
    );
    const res = await (await harness(t)).client.callTool({ name: 'toast_list_orders', arguments: { view: 'brief' } });
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    expect(text.length).toBeLessThanOrEqual(120);
    expect(text).toMatch(/…\s— no date — unknown status$/);
    expect(text).toMatch(LINE);
  });

  it('answers empty text when there are no orders', async () => {
    const t = new FakeTransport(() => json({ data: { orderHistory: { nextPageToken: null, orders: [] } } }));
    const res = await (await harness(t)).client.callTool({ name: 'toast_list_orders', arguments: { view: 'brief' } });
    expect((res.content as Array<{ type: string; text: string }>)[0].text).toBe('');
  });
});
