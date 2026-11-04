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

  /**
   * Restaurant names are written by the restaurants, so the brief lines ride
   * in the fleet's untrusted-data envelope, minified, note first.
   */
  const briefRaw = async (body: unknown): Promise<string> => {
    const t = new FakeTransport(() => json(body));
    const res = await (await harness(t)).client.callTool({ name: 'toast_list_orders', arguments: { view: 'brief' } });
    return (res.content as Array<{ type: string; text: string }>)[0].text;
  };
  const briefLines = async (body: unknown): Promise<string[]> => {
    const raw = await briefRaw(body);
    const parsed = JSON.parse(raw) as { untrusted_content: unknown; note: unknown; data: unknown };
    expect(parsed.untrusted_content).toBe(true);
    expect(typeof parsed.note).toBe('string');
    expect(Array.isArray(parsed.data)).toBe(true);
    return parsed.data as string[];
  };
  const order = (restaurant: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    data: { orderHistory: { nextPageToken: null, orders: [{ guid: 'x', restaurant, ...extra }] } },
  });

  it('answers the untrusted-data envelope, minified, note first, naming who wrote the text', async () => {
    const raw = await briefRaw(fixture('GetGuestOrderHistory'));
    expect(raw).not.toMatch(/\n/);
    expect(Object.keys(JSON.parse(raw))).toEqual(['untrusted_content', 'note', 'data']);
    expect((JSON.parse(raw) as { note: string }).note).toMatch(/restaurant/i);
  });

  it('answers one line per order: title — ISO date — status, each ≤ 120 chars', async () => {
    const lines = (await briefLines(fixture('GetGuestOrderHistory'))).filter((l) => !l.startsWith('-- '));
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
    const [line] = await briefLines(order({ name: 'R'.repeat(200) }));
    expect(line.length).toBeLessThanOrEqual(120);
    expect(line).toMatch(/…\s— no date — unknown status$/);
    expect(line).toMatch(LINE);
  });

  it('cuts the line as a WHOLE when the detail alone would overflow, title first', async () => {
    const [line] = await briefLines(
      order({ name: 'Cafe Long Name' }, { diningOptionBehavior: 'X'.repeat(200) }),
    );
    expect(line.length).toBeLessThanOrEqual(120);
    expect(line.startsWith('Cafe')).toBe(true);
  });

  it('answers the single note "-- none" when there are no orders', async () => {
    expect(await briefLines({ data: { orderHistory: { nextPageToken: null, orders: [] } } })).toEqual(['-- none']);
  });

  it('escapes a restaurant name that starts with "-- " or "\\" with one leading backslash', async () => {
    const [note] = await briefLines(order({ name: '-- none' }));
    expect(note).toBe('\\-- none — no date — unknown status');
    const [slash] = await briefLines(order({ name: '\\Bar' }));
    expect(slash).toBe('\\\\Bar — no date — unknown status');
  });

  it('appends a "-- more" note line when Toast says older orders exist', async () => {
    const lines = await briefLines(fixture('GetGuestOrderHistory'));
    expect(lines.slice(0, -1).every((l) => LINE.test(l))).toBe(true);
    expect(lines.at(-1)).toBe('-- more');
  });

  it('carries GraphQL errors as a "-- error:" note line beside the orders that did arrive', async () => {
    const lines = await briefLines({
      data: { orderHistory: { nextPageToken: null, orders: [{ guid: 'x', restaurant: { name: 'Cafe' } }] } },
      errors: [{ message: 'orders[1].restaurant failed' }, { message: 'timeout' }],
    });
    expect(lines).toEqual([
      'Cafe — no date — unknown status',
      '-- error: Toast reported a partial failure: orders[1].restaurant failed; timeout',
    ]);
  });

  it('answers only the "-- error:" note when an errored response carries no orders', async () => {
    const lines = await briefLines({ data: { orderHistory: null }, errors: [{ message: 'E'.repeat(300) }] });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^-- error: Toast reported a partial failure: E+…$/);
    expect(lines[0].length).toBeLessThanOrEqual(120);
  });
});
