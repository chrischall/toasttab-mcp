import { minifiedResult, resolveView, UNTRUSTED_CONTENT_RULE, untrustedEnvelope, viewParam, type View } from '@chrischall/mcp-utils';
import { z } from 'zod';
import type { OrderSummary } from './parse.js';

/**
 * The `view` rungs this server honours (`@chrischall/mcp-utils` vocabulary).
 *
 * `compact` (default) is the shaped record from `parse.ts`: snake_case keys,
 * nulls for anything Toast did not send, computed `ordering_url` /
 * `distance_miles`. `full` is the gateway's `data` object untouched, for when
 * the shaped view looks wrong and the caller needs to see what Toast sent.
 */
export const TOAST_VIEWS = ['compact', 'full'] as const;

const NOTE =
  'compact (default) returns the shaped result; "full" returns the Toast gateway\'s raw `data` object untouched.';

export const viewArg = (): ReturnType<typeof viewParam> => viewParam(TOAST_VIEWS, { note: NOTE });

export function isFull(view: string | undefined): boolean {
  const rung: View = resolveView(view, TOAST_VIEWS);
  return rung === 'full';
}

/** Minified JSON result; only ever used by read tools. */
export const respond = (data: unknown): ReturnType<typeof minifiedResult> => minifiedResult(data);

/**
 * `toast_list_orders`' `view`: the shared rungs plus `brief`, the one-line-per
 * order answer an mcp-host context-group intent tool asks a canonical read for.
 * `viewParam` offers only the fleet's compact/full/raw vocabulary, so this
 * one enum is spelled out here.
 */
export const ordersViewArg = () =>
  z
    .enum(['compact', 'full', 'brief'])
    .optional()
    .describe(
      `${NOTE} "brief" returns one line per order: restaurant (dining option, item count) — <when placed, ISO date-time, or "no date"> — <status>. The lines ride in the untrusted-data envelope as \`data\` (restaurant names are the restaurants' own text). Note lines start with "-- ": "-- none" when there are no orders, "-- error: …" when Toast reported a partial failure, "-- more" when older orders exist (call again with view "compact" for next_page_token).`,
    );

const BRIEF_MAX = 120;

/** Toast's enum spelling (`READY_FOR_PICKUP`) as words (`ready for pickup`). */
const words = (v: string | null): string | null => (v ? v.toLowerCase().replace(/_/g, ' ') : null);

/** The shortest a restaurant name is cut to before the rest of the line gives way too. */
const TITLE_FLOOR = 24;

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, Math.max(n - 1, 0))}…` : s);

/**
 * One order as one line, `title — <ISO date | no date> — <status>`, cut to at
 * most 120 characters as a WHOLE, title first: the restaurant name shortens
 * until the line fits, and only once it is at its floor does the rest of the
 * line give way. The status is Toast's own value in words; an order with none
 * says `unknown status` rather than inventing one. A name starting `-- ` or
 * `\` is escaped with one leading `\`, so a restaurant can never write a note
 * line (the gateway strips one backslash from every item line).
 */
export function briefOrderLine(order: OrderSummary): string {
  const raw = order.restaurant.name ?? '(unknown restaurant)';
  const name = raw.startsWith('-- ') || raw.startsWith('\\') ? `\\${raw}` : raw;
  const detail = [words(order.dining_option), order.item_count !== null ? `${order.item_count} items` : null].filter(Boolean);
  const suffix = detail.length ? ` (${detail.join(', ')})` : '';
  const tail = `${suffix} — ${order.opened_at ?? 'no date'} — ${words(order.status) ?? 'unknown status'}`;
  if (name.length + tail.length <= BRIEF_MAX) return `${name}${tail}`;
  const shown = cut(name, Math.max(BRIEF_MAX - tail.length, Math.min(name.length, TITLE_FLOOR)));
  return cut(`${shown}${tail}`, BRIEF_MAX);
}

/** The brief lines for one page: `-- none` when there is nothing, else the orders, then the notes. */
export function briefOrderLines(
  orders: OrderSummary[],
  errors: Array<{ message: string }>,
  nextPageToken: string | null,
): string[] {
  const notes = briefOrderNotes(errors, nextPageToken);
  if (orders.length === 0 && notes.length === 0) return ['-- none'];
  return [...orders.map(briefOrderLine), ...notes];
}

const BRIEF_WHO_WROTE = "Restaurant names are written by the restaurants, and error text by Toast's gateway.";

/**
 * The brief answer inside the fleet's untrusted-data envelope, minified, note
 * first — `{ untrusted_content, note, data: string[] }` — because restaurant
 * names are third-party text. mcp-host's intent tools unwrap it and take
 * `data` as the lines.
 */
export const briefResponse = (lines: string[]): ReturnType<typeof minifiedResult> =>
  minifiedResult(untrustedEnvelope(lines, { note: `${BRIEF_WHO_WROTE} ${UNTRUSTED_CONTENT_RULE}` }));

/**
 * The brief view's trailing note lines (a line starting `-- ` is a note, not
 * an order): `-- error: …` when the gateway answered GraphQL `errors` beside
 * whatever data did arrive, and `-- more` when Toast sent a next_page_token.
 * The brief view never silently drops what the compact view reports as
 * `warnings` and `note`.
 */
export function briefOrderNotes(errors: Array<{ message: string }>, nextPageToken: string | null): string[] {
  const notes: string[] = [];
  if (errors.length) {
    const line = `-- error: Toast reported a partial failure: ${errors.map((e) => e.message).join('; ')}`;
    notes.push(line.length > BRIEF_MAX ? `${line.slice(0, BRIEF_MAX - 1)}…` : line);
  }
  if (nextPageToken) notes.push('-- more');
  return notes;
}
