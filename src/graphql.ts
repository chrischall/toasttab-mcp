// GraphQL documents for Toast's online-ordering gateway, plus the read-only
// guard `toast_graphql` relies on.
//
// Provenance — read this before adding a field. Nothing here has been
// live-verified FROM THIS REPO: the gateway refuses non-browser clients (see
// transport-fetchproxy.ts), and no capture was possible when this file was
// written. The two operations below are the ones a public third-party collector
// (github.com/tylerherman19/Coffee, PR #10) runs against the same gateway over
// GET, with exactly these arguments and selections. A field that is not in that
// set is a guess, and a guessed field fails the WHOLE query with a validation
// error — so extend a selection only after `toast_graphql` has shown the field
// exists.
//
// Arguments are inlined as literals rather than passed as `$variables` because
// a variable needs its input TYPE name (`NearbyRestaurantsInput`?), which is
// not known. Inlining is safe: strings go through JSON.stringify (GraphQL
// string escapes are a superset-compatible subset of JSON's), numbers are
// checked finite, and enums come from a closed list.

/** Dining options the restaurant directory accepts. TAKE_OUT is the observed one. */
export const DINING_OPTIONS = ['TAKE_OUT', 'DELIVERY'] as const;
export type DiningOption = (typeof DINING_OPTIONS)[number];

/**
 * Menu visibilities. `ONLINE` is what menusV3 answers with no `visibility`
 * argument (the online-ordering menu); `POS` is the register's full menu,
 * often several times larger.
 */
export type MenuVisibility = 'ONLINE' | 'POS';

export function gqlString(value: string): string {
  return JSON.stringify(value);
}

export function gqlNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`Not a finite number: ${value}`);
  return String(value);
}

export interface NearbyRestaurantsArgs {
  latitude: number;
  longitude: number;
  radiusMiles: number;
  diningOption: DiningOption;
  /** ISO-8601 instant the order would be fulfilled at. */
  fulfillmentDateTime: string;
}

export const RESTAURANT_SELECTION =
  'guid name shortUrl location{address1 city state latitude longitude}';

export function nearbyRestaurantsQuery(args: NearbyRestaurantsArgs): string {
  if (!DINING_OPTIONS.includes(args.diningOption)) {
    throw new Error(`Unknown dining option: ${String(args.diningOption)}`);
  }
  return (
    `{nearbyRestaurants(input:{diningOption:${args.diningOption},` +
    `fulfillmentDateTime:${gqlString(args.fulfillmentDateTime)},` +
    `latitude:${gqlNumber(args.latitude)},longitude:${gqlNumber(args.longitude)},` +
    `radius:${gqlNumber(args.radiusMiles)}}){${RESTAURANT_SELECTION}}}`
  );
}

export const MENU_ITEM_SELECTION = 'guid name description price prices outOfStock';

export function menusQuery(restaurantGuid: string, visibility: MenuVisibility): string {
  // ONLINE is expressed by omitting the argument, exactly as observed; the
  // literal ONLINE enum value has not been seen.
  const clause = visibility === 'POS' ? ',visibility:POS' : '';
  return (
    `{menusV3(input:{restaurantGuid:${gqlString(restaurantGuid)}${clause}}){__typename ` +
    `... on MenusResponse{menus{name groups{name items{${MENU_ITEM_SELECTION}}}}}}}`
  );
}

/** The cheapest document the gateway can answer: used by the healthcheck. */
export const TYPENAME_QUERY = '{__typename}';

/**
 * Throw unless `document` contains only queries (and fragments).
 *
 * `toast_graphql` sends whatever document it is given through the user's
 * signed-in browser, so a mutation there would act on their account. The
 * scanner drops comments and string literals, then looks at every token at
 * brace depth 0 (outside any variable list) — the only place an operation
 * keyword can appear — and refuses `mutation` / `subscription` there. A
 * field merely NAMED "mutation" sits inside braces and is not affected.
 */
export function assertReadOnlyDocument(document: string): void {
  const stripped = document
    .replace(/"""[\s\S]*?"""/g, '""')
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/#[^\n\r]*/g, '');
  let depth = 0;
  let parens = 0;
  let sawOperation = false;
  const token = /[A-Za-z_][A-Za-z0-9_]*|[{}()]|[^\sA-Za-z_{}()]/g;
  for (const match of stripped.matchAll(token)) {
    const t = match[0];
    if (t === '{') {
      if (depth === 0 && parens === 0) sawOperation = true;
      depth++;
      continue;
    }
    if (t === '}') {
      depth--;
      if (depth < 0) throw new Error('Unbalanced braces in GraphQL document.');
      continue;
    }
    if (t === '(') { parens++; continue; }
    if (t === ')') { parens--; continue; }
    if (depth !== 0 || parens !== 0) continue;
    if (t === 'mutation' || t === 'subscription') {
      throw new Error(
        `toast_graphql is read-only: this document contains a ${t}. ` +
          'It would run as you in your signed-in browser, so it is refused.',
      );
    }
  }
  if (depth !== 0) throw new Error('Unbalanced braces in GraphQL document.');
  if (!sawOperation) throw new Error('No GraphQL operation found in document.');
}
