// The guest session Toast's GraphQL gateway requires.
//
// Verified live 2026-10-24 from a bridged order.toasttab.com tab: the gateway
// answers `{"errors":[{"message":"Forbidden"}]}` to every request — GET or
// POST, from Toast's own origin, with the user's cookies — unless it carries
// BOTH
//   - `toast-session-id: <id>`, an id the server issued (a made-up one is
//     still Forbidden), and
//   - `apollographql-client-name: sites-web-client`, the online-ordering SPA's
//     Apollo client name (any other name fails the CORS preflight).
// The SPA gets the id from a server-rendered element on every order.toasttab.com
// page, `<div id="session" data-content="<base64 JSON>"/>`, whose JSON is
// `{"id", "issuedAt", "expiresAt"}` — a one-hour lifetime. Even a 404 page
// carries one (about 12 KB, versus ~830 KB for a real ordering page), which is
// why the client mints from a path that cannot exist.

/** Header the gateway authorises on. */
export const SESSION_HEADER = 'toast-session-id';
/** Apollo client name the gateway (and its CORS policy) accepts. */
export const CLIENT_NAME_HEADER = 'apollographql-client-name';
export const GATEWAY_CLIENT_NAME = 'sites-web-client';
/** An order.toasttab.com path that 404s cheaply but still renders a session. */
export const SESSION_PAGE_PATH = '/online/toasttab-mcp-session';

export interface GuestSession {
  id: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

const ENTITY = /&(?:#x([0-9a-f]+)|#(\d+)|(amp|quot|apos|lt|gt));/gi;
const NAMED: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };

/** Undo HTML attribute escaping (`&#x3D;` is how the page writes base64 padding). */
function decodeEntities(value: string): string {
  return value.replace(ENTITY, (_, hex: string, dec: string, name: string) =>
    hex ? String.fromCodePoint(parseInt(hex, 16)) : dec ? String.fromCodePoint(Number(dec)) : NAMED[name.toLowerCase()],
  );
}

/**
 * Read the guest session out of an order.toasttab.com page. Returns null when
 * the page has no session element or it does not decode to `{id, expiresAt}`.
 */
export function sessionFromPage(html: string): GuestSession | null {
  const tag = html.match(/<[a-z]+\b[^>]*\bid="session"[^>]*>/i)?.[0];
  const content = tag?.match(/\bdata-content="([^"]*)"/i)?.[1];
  if (!content) return null;
  try {
    const parsed = JSON.parse(Buffer.from(decodeEntities(content), 'base64').toString('utf8')) as {
      id?: unknown;
      expiresAt?: unknown;
    };
    const expiresAt = typeof parsed.expiresAt === 'string' ? Date.parse(parsed.expiresAt) : NaN;
    if (typeof parsed.id !== 'string' || parsed.id === '' || Number.isNaN(expiresAt)) return null;
    return { id: parsed.id, expiresAt };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The signed-in guest's session (toast.app)
//
// Guest-account reads (order history, loyalty, Toast Cash) go to the same
// gateway under a different Apollo client, and the gateway keys sessions to
// it: an order.toasttab.com session sent as `capman-guest-app-browser` is
// Forbidden, and vice versa (verified live 2026-10-24). toast.app is a Next.js
// app; it renders its session into the page's React Server Components flight
// data as escaped JSON `{"id","issuedAt","expiresAt"}`, on every page
// including a 404. The guest's identity is a separate bearer token (see
// client.ts); this session alone answers "You are not permitted to call guest".

/** Apollo client name of Toast's guest web app (toast.app). */
export const GUEST_CLIENT_NAME = 'capman-guest-app-browser';
/**
 * toast.app's access-token cookie: a JWT of about 30 minutes, readable by the
 * page, sent as `Authorization: Bearer`. The only cookie this server reads.
 */
export const GUEST_ACCESS_COOKIE = 'toast-customer-access';
/** A toast.app path that 404s but still renders a session. */
export const GUEST_SESSION_PAGE_PATH = '/toasttab-mcp-session';

// The flight data escapes quotes once (`\"`) inside a JS string; tolerate any
// depth of backslash-escaping rather than one exact layer.
const FLIGHT_SESSION =
  /\{\\*"id\\*":\\*"([^"\\]+)\\*",\\*"issuedAt\\*":\\*"[^"\\]+\\*",\\*"expiresAt\\*":\\*"([^"\\]+)\\*"\}/;

/** Read the guest session out of a toast.app page, or null. */
export function sessionFromFlightData(html: string): GuestSession | null {
  const m = html.match(FLIGHT_SESSION);
  if (!m) return null;
  const expiresAt = Date.parse(m[2]);
  return Number.isNaN(expiresAt) ? null : { id: m[1], expiresAt };
}
