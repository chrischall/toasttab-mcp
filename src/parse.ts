// Pure shaping of gateway payloads into what the tools return.
//
// Every reader here is defensive about shape: a missing array is read as empty
// and a mistyped scalar as null — never as a crash, and never invented. The
// shapes were captured live (2026-10-24); Toast can still change them.
import { milesBetween, orderingUrl } from './urls.js';

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

// ---------------------------------------------------------------------------
// Restaurants

/** `nearbyRestaurants` answers at most this many rows; a full page may be truncated. */
export const NEARBY_PAGE_CAP = 300;

export interface Restaurant {
  guid: string | null;
  name: string | null;
  short_url: string | null;
  ordering_url: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  latitude: number | null;
  longitude: number | null;
  distance_miles: number | null;
}

export function shapeRestaurant(raw: unknown, origin?: { latitude: number; longitude: number }): Restaurant {
  const r = obj(raw);
  const loc = obj(r.location);
  const shortUrl = str(r.shortUrl);
  const lat = num(loc.latitude);
  const lng = num(loc.longitude);
  const distance =
    origin && lat !== null && lng !== null
      ? Math.round(milesBetween(origin.latitude, origin.longitude, lat, lng) * 100) / 100
      : null;
  return {
    guid: str(r.guid),
    name: str(r.name),
    short_url: shortUrl,
    ordering_url: shortUrl ? orderingUrl(shortUrl) : null,
    address: str(loc.address1),
    city: str(loc.city),
    state: str(loc.state),
    latitude: lat,
    longitude: lng,
    distance_miles: distance,
  };
}

/** Case- and punctuation-insensitive name containment. */
export function nameMatches(name: string | null, query: string): boolean {
  if (!name) return false;
  // Apostrophes vanish rather than split ("Joe's" ~ "joes"); other punctuation separates words.
  const norm = (s: string) =>
    s.toLowerCase().normalize('NFKD').replace(/['\u2019]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const q = norm(query);
  return q === '' || norm(name).includes(q);
}

/** `__typename` of a union answer, or null. */
export function typenameOf(raw: unknown): string | null {
  return str(obj(raw).__typename);
}

/**
 * The `Restaurant` arm of `restaurantV2ByShortUrl`, or null for any other arm
 * (`GeneralError` for an unknown slug) or a row without a GUID.
 */
export function readRestaurantByShortUrl(raw: unknown): { guid: string; name: string | null; short_url: string | null } | null {
  const r = obj(raw);
  const guid = str(r.guid);
  if (r.__typename !== 'Restaurant' || !guid) return null;
  return { guid, name: str(r.name), short_url: str(r.shortUrl) };
}

// ---------------------------------------------------------------------------
// Menus

export type MenuSource = 'online' | 'pos';

export interface MenuItem {
  guid: string | null;
  name: string | null;
  description: string | null;
  /** As Toast reports it. Null when the item is priced per size (see `prices`). */
  price: number | null;
  /** Per-size prices, when the item has sizes. */
  prices: number[];
  out_of_stock: boolean;
  /** Which menus this item appeared on. */
  sources: MenuSource[];
}

export interface MenuGroup {
  name: string | null;
  items: MenuItem[];
}

export interface Menu {
  name: string | null;
  groups: MenuGroup[];
}

/** One menusV3 response → menus, or null when the union arm was not MenusResponse. */
export function readMenus(data: unknown): { menus: unknown[]; typename: string | null } | null {
  const root = obj(obj(data).menusV3);
  const typename = str(root.__typename);
  if (!Array.isArray(root.menus)) return typename && typename !== 'MenusResponse' ? null : { menus: [], typename };
  return { menus: root.menus, typename };
}

function shapeItem(raw: unknown, source: MenuSource): MenuItem {
  const i = obj(raw);
  return {
    guid: str(i.guid),
    name: str(i.name),
    description: str(i.description),
    price: num(i.price),
    prices: arr(i.prices).map(num).filter((p): p is number => p !== null),
    out_of_stock: i.outOfStock === true,
    sources: [source],
  };
}

/**
 * Merge one or two menu sets (online first, then POS). An item from the second
 * set that the first already listed is not repeated; the first listing records
 * both sources instead. Toast prices an item identically on both, so the
 * online copy loses nothing. Within ONE set, an item listed under several
 * groups (a "Popular" group plus its real category, say) keeps every listing,
 * and all of them share one `sources` array. Items without a GUID are never
 * merged (there is nothing to merge them by).
 */
export function mergeMenus(sets: Array<{ source: MenuSource; menus: unknown[] }>): Menu[] {
  const out: Menu[] = [];
  const firstSeen = new Map<string, { source: MenuSource; sources: MenuSource[] }>();
  for (const { source, menus } of sets) {
    for (const rawMenu of menus) {
      const m = obj(rawMenu);
      const groups: MenuGroup[] = [];
      for (const rawGroup of arr(m.groups)) {
        const g = obj(rawGroup);
        const items: MenuItem[] = [];
        for (const rawItem of arr(g.items)) {
          const item = shapeItem(rawItem, source);
          const prior = item.guid ? firstSeen.get(item.guid) : undefined;
          if (prior && prior.source !== source) {
            if (!prior.sources.includes(source)) prior.sources.push(source);
            continue;
          }
          if (prior) item.sources = prior.sources;
          else if (item.guid) firstSeen.set(item.guid, { source, sources: item.sources });
          items.push(item);
        }
        if (items.length > 0) groups.push({ name: str(g.name), items });
      }
      if (groups.length > 0) out.push({ name: str(m.name), groups });
    }
  }
  return out;
}

export interface MenuFilter {
  query?: string;
  includeOutOfStock: boolean;
  limit: number;
}

export interface FilteredMenus {
  menus: Menu[];
  total_items: number;
  returned: number;
  truncated: boolean;
  out_of_stock_hidden: number;
}

/**
 * Apply the search / stock filter and the item cap, keeping the menu → group
 * nesting so every item still says where it lives. A query matches the item
 * name, its description, or its group's name.
 */
export function filterMenus(menus: Menu[], filter: MenuFilter): FilteredMenus {
  const q = filter.query?.trim().toLowerCase() ?? '';
  let total = 0;
  let returned = 0;
  let hidden = 0;
  const out: Menu[] = [];
  for (const menu of menus) {
    const groups: MenuGroup[] = [];
    for (const group of menu.groups) {
      const groupHit = q !== '' && (group.name ?? '').toLowerCase().includes(q);
      const items: MenuItem[] = [];
      for (const item of group.items) {
        const hit =
          q === '' ||
          groupHit ||
          (item.name ?? '').toLowerCase().includes(q) ||
          (item.description ?? '').toLowerCase().includes(q);
        if (!hit) continue;
        if (item.out_of_stock && !filter.includeOutOfStock) {
          hidden++;
          continue;
        }
        total++;
        if (returned < filter.limit) {
          items.push(item);
          returned++;
        }
      }
      if (items.length > 0) groups.push({ name: group.name, items });
    }
    if (groups.length > 0) out.push({ name: menu.name, groups });
  }
  return { menus: out, total_items: total, returned, truncated: returned < total, out_of_stock_hidden: hidden };
}

// ---------------------------------------------------------------------------
// Guest account (toast.app). Shapes captured live 2026-10-24; fixtures in
// tests/fixtures/guest/. Money is dollars throughout: order totals are numbers
// (`totalV2: 110.52` is shown as $110.52), wallet amounts decimal strings
// ("9.99"), converted here so every amount a tool returns is a number.

/** Epoch-ms (what orderHistory sends) or an ISO string, as ISO-8601 UTC. */
function isoInstant(v: unknown): string | null {
  const t = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** A dollar amount sent as a number or a decimal string. */
function dollars(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  return null;
}

export interface OrderRestaurant {
  guid: string | null;
  name: string | null;
  short_url: string | null;
  ordering_url: string | null;
  time_zone: string | null;
}

function shapeOrderRestaurant(raw: unknown): OrderRestaurant {
  const r = obj(raw);
  const shortUrl = str(r.shortUrl);
  return {
    guid: str(r.guid),
    name: str(r.name),
    short_url: shortUrl,
    ordering_url: shortUrl ? orderingUrl(shortUrl) : null,
    time_zone: str(r.timeZoneId),
  };
}

export interface OrderSummary {
  order_guid: string | null;
  opened_at: string | null;
  /** Toast's `diningOptionBehavior` (TAKE_OUT, DINE_IN, DELIVERY…), verbatim. */
  dining_option: string | null;
  status: string | null;
  item_count: number | null;
  /** The first few selections Toast lists on the order card. */
  items: Array<{ name: string | null; quantity: number | null }>;
  total: number | null;
  restaurant: OrderRestaurant;
}

export function shapeOrderSummary(raw: unknown): OrderSummary {
  const o = obj(raw);
  return {
    order_guid: str(o.guid),
    opened_at: isoInstant(o.openedDateTime),
    dining_option: str(o.diningOptionBehavior),
    status: str(o.orderStatus),
    item_count: num(o.numberOfSelections),
    items: arr(o.selections).map((x) => ({ name: str(obj(x).name), quantity: num(obj(x).quantity) })),
    total: dollars(o.totalV2),
    restaurant: shapeOrderRestaurant(o.restaurant),
  };
}

/** `orderHistory`: one page of orders, newest first, plus the token for the next. */
export function readOrderHistory(data: unknown): { orders: OrderSummary[]; next_page_token: string | null } {
  const h = obj(obj(data).orderHistory);
  return { orders: arr(h.orders).map(shapeOrderSummary), next_page_token: str(h.nextPageToken) };
}

export interface OrderDetail {
  order_guid: string | null;
  check_guid: string | null;
  check_number: number | null;
  opened_at: string | null;
  dining_option: string | null;
  status: string | null;
  restaurant: OrderRestaurant;
  /**
   * `price` is Toast's per-selection figure, verbatim. Whether it is per
   * unit or per line for quantity > 1 has not been verified.
   */
  items: Array<{ name: string | null; quantity: number | null; price: number | null; modifiers: string[] }>;
  subtotal: number | null;
  discounts_total: number | null;
  tax: number | null;
  tip: number | null;
  service_charges: {
    delivery: number | null;
    gratuity: number | null;
    processing: number | null;
    other: number | null;
  };
  gift_card_applied: number | null;
  total: number | null;
  payments: Array<{
    type: string | null;
    card_type: string | null;
    last4: string | null;
    other_name: string | null;
    amount: number | null;
    total_amount: number | null;
  }>;
  delivery_address: string | null;
  delivery_provider: string | null;
}

/** `completedOrder`: one order's receipt. Null when Toast returned none. */
export function readCompletedOrder(data: unknown): OrderDetail | null {
  const raw = obj(data).completedOrder;
  if (!raw || typeof raw !== 'object') return null;
  const o = obj(raw);
  const d = obj(o.deliveryInfo);
  const address = [str(d.address1), str(d.address2), str(d.city), [str(d.state), str(d.zipCode)].filter(Boolean).join(' ')]
    .filter((x): x is string => typeof x === 'string' && x !== '')
    .join(', ');
  return {
    order_guid: str(o.guid),
    check_guid: str(o.checkGuid),
    check_number: num(o.checkNumber),
    opened_at: isoInstant(o.openedDateTime),
    dining_option: str(o.diningOptionBehavior),
    status: str(o.orderStatus),
    restaurant: shapeOrderRestaurant(o.restaurant),
    items: arr(o.selections).map((x) => {
      const sel = obj(x);
      return {
        name: str(sel.name),
        quantity: num(sel.quantity),
        price: dollars(sel.price),
        modifiers: arr(sel.modifiers).map((m) => str(obj(m).name)).filter((m): m is string => m !== null),
      };
    }),
    subtotal: dollars(o.preDiscountItemsSubtotal),
    discounts_total: dollars(o.discountsTotal),
    tax: dollars(o.taxV2),
    tip: dollars(o.tip),
    service_charges: {
      delivery: dollars(o.deliveryServiceCharges),
      gratuity: dollars(o.gratuityServiceCharges),
      processing: dollars(o.processingServiceCharges),
      other: dollars(o.nonDeliveryNonGratuityNonUbpServiceCharges),
    },
    gift_card_applied: dollars(obj(o.giftCard).appliedBalance),
    total: dollars(o.totalV2),
    payments: arr(o.payments).map((x) => {
      const p = obj(x);
      return {
        type: str(p.type),
        card_type: str(p.cardType),
        last4: str(p.last4Digits),
        other_name: str(p.otherPaymentName),
        amount: dollars(p.amount),
        total_amount: dollars(p.totalAmount),
      };
    }),
    delivery_address: address === '' ? null : address,
    delivery_provider: str(obj(o.deliveryServiceInfo).providerName),
  };
}

export interface LoyaltyProgram {
  loyalty_account_guid: string | null;
  program_name: string | null;
  restaurant: { guid: string | null; name: string | null; short_url: string | null; online_ordering: boolean | null };
  /** Balances as Toast reports them, e.g. `{type: "POINTS", balance: 25}`. */
  balances: Array<{ type: string | null; balance: number | null }>;
  rewards: Array<{
    available: boolean | null;
    target: number | null;
    left_to_target: number | null;
    tags: string[];
    next_reward: string | null;
    label: string | null;
    value: string | null;
    unlocked: string | null;
  }>;
  /** How many locations share this program (Toast's `restaurantsInLoyaltySet`). */
  locations: number;
}

/** `guest.allLoyaltyAccountInfos`: every restaurant loyalty program the guest is in. */
export function readLoyalty(data: unknown): LoyaltyProgram[] {
  const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
  return arr(obj(obj(data).guest).allLoyaltyAccountInfos).map((x) => {
    const a = obj(x);
    const r = obj(a.restaurant);
    return {
      loyalty_account_guid: str(a.loyaltyAccountGuid),
      program_name: str(a.programName),
      restaurant: { guid: str(r.guid), name: str(r.name), short_url: str(r.shortUrl), online_ordering: bool(r.onlineOrderingEnabled) },
      balances: arr(a.balances).map((b) => ({ type: str(obj(b).type), balance: num(obj(b).balance) })),
      rewards: arr(a.rewards).map((w) => {
        const rw = obj(w);
        const m = obj(rw.rewardMessages);
        return {
          available: bool(rw.available),
          target: num(rw.target),
          left_to_target: num(rw.leftToTarget),
          tags: arr(rw.tags).map(str).filter((t): t is string => t !== null),
          next_reward: str(m.nextRewardMessage),
          label: str(m.rewardLabelMessage),
          value: str(m.rewardValueMessage),
          unlocked: str(m.unlockedMessage),
        };
      }),
      locations: arr(obj(r.loyaltyFeatures).restaurantsInLoyaltySet).length,
    };
  });
}

const account = (data: unknown) => obj(obj(obj(obj(data).guest).wallet).guestCurrencyAccount);
const money = (v: unknown) => ({ amount: dollars(obj(v).amount), currency: str(obj(v).currency) });

export interface Wallet {
  /** Toast Cash, stored value included (`availableBalanceWithStoredValue`). */
  balance: { amount: number | null; currency: string | null };
  /** The soonest day on which part of the balance expires, if any. */
  next_expiry: { amount: number | null; currency: string | null; date: string | null } | null;
}

/** `guest.wallet.guestCurrencyAccount` from GetGuestWallet. */
export function readWallet(data: unknown): Wallet {
  const a = account(data);
  const next = a.nearestFutureExpirableDayValue;
  return {
    balance: money(a.availableBalanceWithStoredValue),
    next_expiry: next && typeof next === 'object' ? { ...money(obj(next).amount), date: str(obj(next).expirationDate) } : null,
  };
}

/** Units of the balance that expire (GetGuestCurrencyExpirableUnits). */
export function readExpiringUnits(data: unknown): {
  units: Array<{ amount: number | null; currency: string | null; expires_at: string | null; reason: string | null }>;
  more: boolean;
} {
  const page = obj(account(data).expirableUnits);
  return {
    units: arr(page.items).map((x) => {
      const u = obj(x);
      return { ...money(u.availableBalance), expires_at: isoInstant(u.expirationDateTime), reason: str(u.issuanceReason) };
    }),
    more: str(page.nextPageToken) !== null,
  };
}

/**
 * Units the guest has received (GetGuestCurrencyReceivedUnits). A gift of
 * stored value arrives as `GuestCurrencyStoredValueGiftUnit` with a sender.
 * Field names come from Toast's document; no non-empty row has been observed.
 */
export function readReceivedUnits(data: unknown): Array<{
  kind: string | null;
  amount: number | null;
  currency: string | null;
  issued_at: string | null;
  reason: string | null;
  gift_from: string | null;
}> {
  return arr(obj(account(data).receivedUnits).items).map((x) => {
    const u = obj(x);
    return {
      kind: str(u.__typename),
      ...money(u.issuedAmount),
      issued_at: isoInstant(u.issuedDateTime),
      reason: str(u.issuanceReason),
      gift_from: str(obj(u.giftDetails).senderName),
    };
  });
}
