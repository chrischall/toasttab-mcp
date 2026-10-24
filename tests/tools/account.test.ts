import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { ToastClient } from '../../src/client.js';
import { registerAccountTools } from '../../src/tools/account.js';
import { createTestHarness, parseToolResult, type TestHarness } from '../helpers.js';
import { FakeTransport, json } from '../fake-transport.js';

// Live captures (2026-10-24), scrubbed: real shapes, typenames and enums;
// GUIDs, names, addresses and amounts replaced.
const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../fixtures/guest/${name}.json`, import.meta.url), 'utf8')) as { data: unknown };

const BY_OPERATION: Record<string, string> = {
  capmanGuestApp_GetGuestOrderHistory: 'GetGuestOrderHistory',
  capmanGuestApp_GetCompletedOrder: 'GetCompletedOrder',
  capmanGuestApp_GetGuestRewards: 'GetGuestRewards',
  capmanGuestApp_GetGuestWallet: 'GetGuestWallet',
  capmanGuestApp_GetGuestCurrencyExpirableUnits: 'GetGuestCurrencyExpirableUnits',
  capmanGuestApp_GetGuestCurrencyReceivedUnits: 'GetGuestCurrencyReceivedUnits',
};

const operation = (path: string) => new URL(path, 'https://x.invalid').searchParams.get('operationName') ?? '';
const variables = (path: string) => JSON.parse(new URL(path, 'https://x.invalid').searchParams.get('variables') ?? 'null');

/** Answers each guest operation with its captured fixture. */
const fromFixtures = () => new FakeTransport((init) => json(fixture(BY_OPERATION[operation(init.path)])));

let h: TestHarness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

async function harness(t: FakeTransport) {
  h = await createTestHarness((server) => registerAccountTools(server, new ToastClient(t)));
  return h;
}

const RESTAURANT = '00000000-0000-4000-8000-000000000004';
const ORDER = '00000000-0000-4000-8000-000000000001';

describe('toast_list_orders', () => {
  it('shapes the captured order history and asks for it the way toast.app does', async () => {
    const t = fromFixtures();
    const res = parseToolResult<{ returned: number; next_page_token: string; orders: unknown[] }>(
      await (await harness(t)).callTool('toast_list_orders', {}),
    );
    expect(variables(t.requests[0].path)).toEqual({ input: { pageSize: 20, nextPageToken: null, showAllOrdersFromAllSources: true } });
    expect(res.returned).toBe(2);
    expect(res.next_page_token).toBe('TEST_NEXT_PAGE_TOKEN');
    expect(res.orders[0]).toEqual({
      order_guid: ORDER,
      // openedDateTime is epoch milliseconds on the wire.
      opened_at: new Date(1768501800000).toISOString(),
      dining_option: 'TAKE_OUT',
      status: 'READY_FOR_PICKUP',
      item_count: 6,
      items: [{ name: 'name-1', quantity: 1 }, { name: 'name-2', quantity: 1 }],
      total: 12.34,
      restaurant: {
        guid: RESTAURANT,
        name: 'name-3',
        short_url: 'shortUrl-4',
        ordering_url: 'https://order.toasttab.com/online/shortUrl-4',
        time_zone: 'America/New_York',
      },
    });
  });

  it('forwards next_page_token and page_size', async () => {
    const t = fromFixtures();
    await (await harness(t)).callTool('toast_list_orders', { page_size: 5, next_page_token: 'abc' });
    expect(variables(t.requests[0].path).input).toMatchObject({ pageSize: 5, nextPageToken: 'abc' });
  });

  it('returns the raw gateway data on view "full"', async () => {
    const res = parseToolResult<{ data: unknown }>(await (await harness(fromFixtures())).callTool('toast_list_orders', { view: 'full' }));
    expect(res.data).toEqual(fixture('GetGuestOrderHistory').data);
  });

  it('says how to sign in when the browser has no toast.app session', async () => {
    const t = fromFixtures();
    t.cookies = {};
    const res = await (await harness(t)).callTool('toast_list_orders', {});
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/toast\.app/);
    expect(t.requests).toHaveLength(0);
  });
});

describe('toast_get_order', () => {
  it('shapes the captured receipt', async () => {
    const t = fromFixtures();
    const res = parseToolResult<{ order: Record<string, unknown> }>(
      await (await harness(t)).callTool('toast_get_order', { restaurant_guid: RESTAURANT.toUpperCase(), order_guid: ORDER }),
    );
    expect(variables(t.requests[0].path)).toEqual({ input: { restaurantGuid: RESTAURANT, orderGuid: ORDER } });
    expect(res.order).toMatchObject({
      order_guid: ORDER,
      check_number: 7,
      dining_option: 'TAKE_OUT',
      items: [
        { name: 'name-18', quantity: 1, price: 20, modifiers: ['name-16', 'name-17'] },
        { name: 'name-21', quantity: 1, price: 18, modifiers: ['name-19', 'name-20'] },
      ],
      subtotal: 7,
      discounts_total: 0,
      tax: 12.34,
      tip: 10,
      service_charges: { delivery: 0, gratuity: 0, processing: 0, other: 0 },
      gift_card_applied: null,
      total: 12.34,
      payments: [{ type: 'CREDIT', card_type: 'AMEX', last4: '0000', other_name: null, amount: 12.34, total_amount: 12.34 }],
      delivery_address: 'address1-11, address2-12, city-13, NC 00000',
      delivery_provider: null,
    });
  });

  it('refuses a non-GUID before any request', async () => {
    const t = fromFixtures();
    const res = await (await harness(t)).callTool('toast_get_order', { restaurant_guid: 'joes-pizza', order_guid: ORDER });
    expect(res.isError).toBe(true);
    expect(t.requests).toHaveLength(0);
  });

  it('says so when Toast returns no order', async () => {
    const t = new FakeTransport(() => json({ data: { completedOrder: null } }));
    const res = parseToolResult<{ order: null; next_step: string }>(
      await (await harness(t)).callTool('toast_get_order', { restaurant_guid: RESTAURANT, order_guid: ORDER }),
    );
    expect(res.order).toBeNull();
    expect(res.next_step).toMatch(/toast_list_orders/);
  });
});

describe('toast_get_loyalty', () => {
  it('shapes the captured programs', async () => {
    const res = parseToolResult<{ total: number; programs: Array<Record<string, unknown>> }>(
      await (await harness(fromFixtures())).callTool('toast_get_loyalty', {}),
    );
    expect(res.total).toBe(2);
    expect(res.programs[0]).toEqual({
      loyalty_account_guid: '00000000-0000-4000-8000-000000000012',
      program_name: 'programName-28',
      restaurant: { guid: '00000000-0000-4000-8000-000000000013', name: 'name-29', short_url: 'shortUrl-30', online_ordering: true },
      balances: [{ type: 'POINTS', balance: 25 }],
      rewards: [
        {
          available: false,
          target: 50,
          left_to_target: 25,
          tags: ['WALLET_BALANCE', 'CASHBACK'],
          next_reward: 'nextRewardMessage-25',
          label: 'rewardLabelMessage-26',
          value: 'rewardValueMessage-27',
          unlocked: null,
        },
      ],
      locations: 2,
    });
    expect(res.programs[1]).toMatchObject({ rewards: [{ available: true, left_to_target: 0, unlocked: 'unlockedMessage-41' }] });
  });
});

describe('toast_get_wallet', () => {
  it('converts the decimal-string balance to dollars and passes a time zone', async () => {
    const t = fromFixtures();
    const res = parseToolResult<Record<string, unknown>>(await (await harness(t)).callTool('toast_get_wallet', {}));
    expect(res).toMatchObject({
      balance: { amount: 4.5, currency: 'USD' },
      next_expiry: null,
      expiring_units: [],
      received_units: [],
    });
    expect(typeof res.time_zone).toBe('string');
    const walletCall = t.requests.find((r) => operation(r.path) === 'capmanGuestApp_GetGuestWallet');
    expect(variables(walletCall?.path ?? '')).toEqual({ timeZone: res.time_zone });
  });

  it('shapes expiring and received units, gifts included', async () => {
    const t = new FakeTransport((init) => {
      const op = operation(init.path);
      const wallet = (account: unknown) => json({ data: { guest: { wallet: { guestCurrencyAccount: account } } } });
      if (op.endsWith('ExpirableUnits')) {
        return wallet({
          expirableUnits: {
            items: [{ availableBalance: { amount: '2.00', currency: 'USD' }, expirationDateTime: '2027-01-01T05:00:00Z', issuanceReason: 'PROMOTION' }],
            nextPageToken: 'more',
          },
        });
      }
      if (op.endsWith('ReceivedUnits')) {
        return wallet({
          receivedUnits: {
            items: [
              {
                __typename: 'GuestCurrencyStoredValueGiftUnit',
                issuanceReason: 'GIFT',
                issuedAmount: { amount: '25.00', currency: 'USD' },
                issuedDateTime: '2026-09-01T12:00:00Z',
                giftDetails: { senderName: 'A Friend' },
              },
            ],
          },
        });
      }
      return wallet({
        availableBalanceWithStoredValue: { amount: '27.00', currency: 'USD' },
        nearestFutureExpirableDayValue: { amount: { amount: '2.00', currency: 'USD' }, expirationDate: '2027-01-01' },
      });
    });
    const res = parseToolResult<Record<string, unknown>>(await (await harness(t)).callTool('toast_get_wallet', {}));
    expect(res).toMatchObject({
      balance: { amount: 27, currency: 'USD' },
      next_expiry: { amount: 2, currency: 'USD', date: '2027-01-01' },
      expiring_units: [{ amount: 2, currency: 'USD', expires_at: '2027-01-01T05:00:00.000Z', reason: 'PROMOTION' }],
      received_units: [
        { kind: 'GuestCurrencyStoredValueGiftUnit', amount: 25, currency: 'USD', issued_at: '2026-09-01T12:00:00.000Z', reason: 'GIFT', gift_from: 'A Friend' },
      ],
    });
    expect(res.note).toMatch(/more expiring units/);
  });
});
