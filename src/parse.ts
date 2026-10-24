// Pure shaping of gateway payloads into what the tools return.
//
// Every reader here is defensive about shape: the payloads were described by a
// third party, not captured by this repo, so a missing array is read as empty
// and a mistyped scalar as null — never as a crash, and never invented.
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
 * Merge one or two menu sets (online first, then POS). An item seen on both
 * is listed once, where it first appeared, with both sources recorded — Toast
 * prices an item identically on both, so the online copy loses nothing.
 * Items without a GUID are never merged (there is nothing to merge them by).
 */
export function mergeMenus(sets: Array<{ source: MenuSource; menus: unknown[] }>): Menu[] {
  const out: Menu[] = [];
  const seen = new Map<string, MenuItem>();
  for (const { source, menus } of sets) {
    for (const rawMenu of menus) {
      const m = obj(rawMenu);
      const groups: MenuGroup[] = [];
      for (const rawGroup of arr(m.groups)) {
        const g = obj(rawGroup);
        const items: MenuItem[] = [];
        for (const rawItem of arr(g.items)) {
          const item = shapeItem(rawItem, source);
          const prior = item.guid ? seen.get(item.guid) : undefined;
          if (prior) {
            if (!prior.sources.includes(source)) prior.sources.push(source);
            continue;
          }
          if (item.guid) seen.set(item.guid, item);
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
