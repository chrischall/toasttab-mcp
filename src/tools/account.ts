import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { ToastClient } from '../client.js';
import {
  COMPLETED_ORDER,
  EXPIRABLE_UNITS,
  ORDER_HISTORY,
  RECEIVED_UNITS,
  REWARDS,
  WALLET,
} from '../guest-documents.js';
import {
  readCompletedOrder,
  readExpiringUnits,
  readLoyalty,
  readOrderHistory,
  readReceivedUnits,
  readWallet,
} from '../parse.js';
import { isGuid } from '../urls.js';
import { isFull, respond, viewArg } from '../view.js';

// Every tool here reads the signed-in guest's own account through their
// toast.app session in the bridged browser (client.ts guestGraphql). All are
// queries; nothing here can order, redeem, or change the account.
const READ = { readOnlyHint: true, idempotentHint: true, openWorldHint: true } as const;

const SIGN_IN = 'Needs a toast.app sign-in in the browser running ContextMint Bridge.';

const guid = (what: string) =>
  z
    .string()
    .refine(isGuid, { message: `${what} must be a GUID (from toast_list_orders)` })
    .transform((g) => g.toLowerCase());

export function registerAccountTools(server: McpServer, client: ToastClient): void {
  server.registerTool(
    'toast_list_orders',
    {
      description:
        `Your Toast order history, newest first: each order's GUID, restaurant (GUID, name, ordering link), when it was placed (ISO-8601 UTC, plus the restaurant's time zone), dining option and status as Toast reports them, item count with the first few items, and total in dollars. Pass next_page_token from the previous answer for older orders. Use toast_get_order for a full receipt. ${SIGN_IN}`,
      inputSchema: z.object({
        page_size: z.number().int().min(1).max(50).default(20).describe('Orders per page (1–50, default 20).'),
        next_page_token: z.string().min(1).optional().describe('From a previous answer, to fetch the next (older) page.'),
        view: viewArg(),
      }),
      annotations: READ,
    },
    async ({ page_size, next_page_token, view }) => {
      const { data, errors } = await client.guestGraphql(ORDER_HISTORY, {
        // showAllOrdersFromAllSources mirrors toast.app's own Orders page.
        input: { pageSize: page_size, nextPageToken: next_page_token ?? null, showAllOrdersFromAllSources: true },
      });
      if (isFull(view)) return respond({ data, errors });
      const page = readOrderHistory(data);
      return respond({
        returned: page.orders.length,
        next_page_token: page.next_page_token,
        ...(page.next_page_token ? { note: 'Older orders exist: call again with next_page_token.' } : {}),
        ...(errors.length ? { warnings: errors.map((e) => e.message) } : {}),
        orders: page.orders,
      });
    },
  );

  server.registerTool(
    'toast_get_order',
    {
      description:
        `One of your past Toast orders as a receipt: items with modifiers and price, subtotal, discounts, tax, tip, service charges, gift card applied, total (all dollars), payments (type, card brand, last 4), and delivery address/provider when it was delivered. Takes the restaurant and order GUIDs from toast_list_orders. ${SIGN_IN}`,
      inputSchema: z.object({
        restaurant_guid: guid('restaurant_guid'),
        order_guid: guid('order_guid'),
        view: viewArg(),
      }),
      annotations: READ,
    },
    async ({ restaurant_guid, order_guid, view }) => {
      const { data, errors } = await client.guestGraphql(COMPLETED_ORDER, {
        input: { restaurantGuid: restaurant_guid, orderGuid: order_guid },
      });
      if (isFull(view)) return respond({ data, errors });
      const order = readCompletedOrder(data);
      if (!order) {
        return respond({
          order: null,
          next_step: 'Toast returned no order for that pair. Check both GUIDs came from the same toast_list_orders row.',
          ...(errors.length ? { warnings: errors.map((e) => e.message) } : {}),
        });
      }
      return respond({ ...(errors.length ? { warnings: errors.map((e) => e.message) } : {}), order });
    },
  );

  server.registerTool(
    'toast_get_loyalty',
    {
      description:
        `Your Toast restaurant loyalty programs: for each, the restaurant, program name, balances (e.g. POINTS), and reward progress (target, left to target, whether a reward is available, Toast's own reward messages). ${SIGN_IN}`,
      inputSchema: z.object({ view: viewArg() }),
      annotations: READ,
    },
    async ({ view }) => {
      const { data, errors } = await client.guestGraphql(REWARDS);
      if (isFull(view)) return respond({ data, errors });
      const programs = readLoyalty(data);
      return respond({
        total: programs.length,
        ...(errors.length ? { warnings: errors.map((e) => e.message) } : {}),
        programs,
      });
    },
  );

  server.registerTool(
    'toast_get_wallet',
    {
      description:
        `Your Toast Cash: the available balance (stored value such as gifted Toast Cash included), the next expiry, the units that expire, and the units you have received (gifts name the sender). All amounts in dollars. ${SIGN_IN}`,
      inputSchema: z.object({ view: viewArg() }),
      annotations: READ,
    },
    async ({ view }) => {
      // GetGuestWallet requires a time zone for "nearest expiry day"; the
      // server's own is the closest thing to the user's.
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const wallet = await client.guestGraphql(WALLET, { timeZone });
      const expiring = await client.guestGraphql(EXPIRABLE_UNITS);
      const received = await client.guestGraphql(RECEIVED_UNITS);
      const errors = [...wallet.errors, ...expiring.errors, ...received.errors];
      if (isFull(view)) {
        return respond({ data: { wallet: wallet.data, expirable_units: expiring.data, received_units: received.data }, errors });
      }
      const units = readExpiringUnits(expiring.data);
      return respond({
        ...readWallet(wallet.data),
        time_zone: timeZone,
        expiring_units: units.units,
        ...(units.more ? { note: 'Toast holds more expiring units than one page; view "full" shows the raw page.' } : {}),
        received_units: readReceivedUnits(received.data),
        ...(errors.length ? { warnings: errors.map((e) => e.message) } : {}),
      });
    },
  );
}
