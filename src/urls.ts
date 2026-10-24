// Turning whatever a user pastes into a Toast restaurant reference.
//
// Toast names a restaurant two ways:
//   - a GUID, which the GraphQL gateway keys on (`menusV3` takes only this);
//   - a `shortUrl` slug, the readable part of an ordering link
//     (`https://order.toasttab.com/online/<shortUrl>`).
// Links carry one or the other: a toast.app deep link embeds `r-<guid>`, an
// ordering link usually carries only the slug (sometimes `?guid=` too).

const GUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const GUID_EXACT = new RegExp(`^${GUID}$`, 'i');
const GUID_ANY = new RegExp(`(?:^|[^0-9a-f])(${GUID})(?![0-9a-f])`, 'i');
const SLUG = /^[a-z0-9][a-z0-9-]{1,}[a-z0-9]$/i;

/** First path segments on toasttab.com that are Toast's own pages, not a restaurant. */
const NOT_A_SHORT_URL = new Set([
  'online', 'local', 'restaurants', 'gift-cards', 'giftcards', 'checkout', 'account',
  'login', 'signup', 'about', 'pos', 'blog', 'support', 'order', 'r', 'search',
]);

export interface ToastReference {
  guid: string | null;
  shortUrl: string | null;
}

export function isGuid(value: string): boolean {
  return GUID_EXACT.test(value);
}

function isToastHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'toasttab.com' || h.endsWith('.toasttab.com') || h === 'toast.app' || h.endsWith('.toast.app');
}

/**
 * Parse a GUID, a shortUrl slug, or a Toast link. Returns nulls for what the
 * input does not carry; throws only when the input is not recognisably Toast.
 */
export function parseToastReference(input: string): ToastReference {
  const raw = input.trim();
  if (isGuid(raw)) return { guid: raw.toLowerCase(), shortUrl: null };
  if (SLUG.test(raw) && !NOT_A_SHORT_URL.has(raw.toLowerCase())) {
    return { guid: null, shortUrl: raw.toLowerCase() };
  }

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new Error(`Not a Toast GUID, shortUrl or link: "${input}"`);
  }
  if (!isToastHost(url.hostname)) {
    throw new Error(`Not a Toast link (host ${url.hostname}). Pass a toasttab.com / toast.app link, a restaurant GUID, or its shortUrl.`);
  }

  const queryGuid = url.searchParams.get('guid') ?? url.searchParams.get('restaurantGuid');
  const pathGuid = url.pathname.match(GUID_ANY)?.[1];
  const guid = queryGuid && isGuid(queryGuid) ? queryGuid : pathGuid ?? null;

  const segments = url.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s).toLowerCase());
  let shortUrl: string | null = null;
  if (url.hostname.toLowerCase().endsWith('toasttab.com')) {
    // order.toasttab.com/online/<slug>[/...]; www.toasttab.com/<slug>[/...]
    const candidate = segments[0] === 'online' ? segments[1] : segments[0];
    if (candidate && SLUG.test(candidate) && !NOT_A_SHORT_URL.has(candidate) && !isGuid(candidate)) {
      shortUrl = candidate;
    }
  }
  if (!guid && !shortUrl) {
    throw new Error(`Could not find a restaurant GUID or shortUrl in "${input}".`);
  }
  return { guid: guid ? guid.toLowerCase() : null, shortUrl };
}

export function orderingUrl(shortUrl: string): string {
  return `https://order.toasttab.com/online/${encodeURIComponent(shortUrl)}`;
}

/** Great-circle distance in miles. */
export function milesBetween(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}
