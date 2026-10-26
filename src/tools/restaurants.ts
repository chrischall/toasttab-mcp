import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { ToastClient } from '../client.js';
import { DINING_OPTIONS, nearbyRestaurantsQuery, restaurantByShortUrlQuery } from '../graphql.js';
import { nameMatches, NEARBY_PAGE_CAP, readRestaurantByShortUrl, shapeRestaurant, typenameOf, type Restaurant } from '../parse.js';
import { parseToastReference } from '../urls.js';
import { isFull, respond, viewArg } from '../view.js';

const READ = { readOnlyHint: true, idempotentHint: true, openWorldHint: true } as const;

const latitude = z.number().min(-90).max(90).describe('Latitude of the search centre, decimal degrees.');
const longitude = z.number().min(-180).max(180).describe('Longitude of the search centre, decimal degrees.');
const radius = z
  .number()
  .min(0.1)
  .max(25)
  .default(2)
  .describe('Search radius in miles (0.1–25, default 2). Toast caps one answer at 300 restaurants.');

/**
 * The instant to ask about. Toast's directory filters by "open for this
 * dining option at this time", so `now` answers "who can I order from now";
 * a caller wanting every restaurant regardless of hours should pass a time
 * inside normal trading hours (e.g. today at 12:00 local).
 */
function fulfillmentTime(when: string | undefined): string {
  if (!when) return new Date().toISOString();
  const t = Date.parse(when);
  if (Number.isNaN(t)) throw new Error(`Unrecognised date-time "${when}". Use ISO-8601, e.g. 2026-10-24T18:30:00-04:00.`);
  return new Date(t).toISOString();
}

export interface NearbyArgs {
  latitude: number;
  longitude: number;
  radiusMiles: number;
  diningOption: (typeof DINING_OPTIONS)[number];
  when?: string;
}

/** One directory call, shaped and sorted nearest-first. Shared with resolve. */
export async function findNearby(client: ToastClient, args: NearbyArgs) {
  const query = nearbyRestaurantsQuery({
    latitude: args.latitude,
    longitude: args.longitude,
    radiusMiles: args.radiusMiles,
    diningOption: args.diningOption,
    fulfillmentDateTime: fulfillmentTime(args.when),
  });
  const { data, errors } = await client.graphql<{ nearbyRestaurants?: unknown }>(query);
  const rows = Array.isArray(data.nearbyRestaurants) ? data.nearbyRestaurants : [];
  const origin = { latitude: args.latitude, longitude: args.longitude };
  const restaurants = rows
    .map((r) => shapeRestaurant(r, origin))
    .sort((a, b) => (a.distance_miles ?? Infinity) - (b.distance_miles ?? Infinity));
  return { data, errors, restaurants, capped: rows.length >= NEARBY_PAGE_CAP };
}

export function registerRestaurantTools(server: McpServer, client: ToastClient): void {
  server.registerTool(
    'toast_find_restaurants',
    {
      description:
        "Find restaurants that take orders through Toast near a point (latitude/longitude — this server has no geocoder, so convert an address or city first). Returns each restaurant's GUID (what toast_get_menu needs), shortUrl, ordering link, address and distance, nearest first. Toast's directory lists restaurants OPEN for the dining option at `when` (default now): an empty or short result late at night means closed, not absent — retry with a daytime `when`. Optional `name` filters the results. There is no paging: `total` is every match and `limit` (default 25, max 300) is how many come back.",
      inputSchema: z.object({
        latitude,
        longitude,
        radius_miles: radius,
        name: z.string().optional().describe('Only restaurants whose name contains this (case/punctuation-insensitive).'),
        dining_option: z
          .enum(DINING_OPTIONS)
          .default('TAKE_OUT')
          .describe('TAKE_OUT (default) or DELIVERY. DELIVERY lists only restaurants that deliver to the point.'),
        when: z.string().optional().describe('ISO-8601 date-time the order would be fulfilled at. Default: now.'),
        limit: z.number().int().min(1).max(NEARBY_PAGE_CAP).default(25).describe('Max restaurants to return (default 25).'),
        view: viewArg(),
      }),
      annotations: READ,
    },
    async ({ latitude, longitude, radius_miles, name, dining_option, when, limit, view }) => {
      const found = await findNearby(client, {
        latitude,
        longitude,
        radiusMiles: radius_miles,
        diningOption: dining_option,
        when,
      });
      if (isFull(view)) return respond({ data: found.data, errors: found.errors });
      const matched: Restaurant[] = name ? found.restaurants.filter((r) => nameMatches(r.name, name)) : found.restaurants;
      const returned = Math.min(limit, matched.length);
      // There is no page token: `limit` is the only way past the first rows,
      // so say so rather than leave the caller assuming the list is complete.
      const notes = [
        ...(returned < matched.length
          ? [`${matched.length} matched, ${returned} returned: pass a larger limit (max ${NEARBY_PAGE_CAP}) to see the rest.`]
          : []),
        ...(found.capped
          ? [`Toast returned its ${NEARBY_PAGE_CAP}-row maximum: the area may hold more. Narrow radius_miles to see them.`]
          : []),
      ];
      return respond({
        total: matched.length,
        returned,
        ...(notes.length ? { note: notes.join(' ') } : {}),
        ...(found.errors.length ? { warnings: found.errors.map((e) => e.message) } : {}),
        restaurants: matched.slice(0, limit),
      });
    },
  );

  server.registerTool(
    'toast_resolve_restaurant',
    {
      description:
        "Turn a Toast link, shortUrl, or GUID into the restaurant GUID that toast_get_menu needs. Links that carry a GUID (toast.app r-<guid> links, ?guid= parameters, bare GUIDs) resolve without a network call; an order.toasttab.com/online/<shortUrl> link or bare shortUrl is looked up in Toast by its slug. Returns guid: null with a next step when Toast does not know the slug.",
      inputSchema: z.object({
        reference: z.string().min(1).describe('A Toast ordering link, toast.app link, restaurant GUID, or shortUrl slug.'),
      }),
      annotations: READ,
    },
    async ({ reference }) => {
      const ref = parseToastReference(reference);
      if (ref.guid) return respond({ guid: ref.guid, short_url: ref.shortUrl, resolved_by: 'reference' });
      const shortUrl = ref.shortUrl as string;

      const { data } = await client.graphql<{ restaurantV2ByShortUrl?: unknown }>(restaurantByShortUrlQuery(shortUrl));
      const hit = readRestaurantByShortUrl(data.restaurantV2ByShortUrl);
      if (hit) return respond({ guid: hit.guid, short_url: hit.short_url ?? shortUrl, name: hit.name, resolved_by: 'short_url' });
      return respond({
        guid: null,
        short_url: shortUrl,
        resolved_by: null,
        toast_answer: typenameOf(data.restaurantV2ByShortUrl),
        next_step:
          "Toast does not know this shortUrl. Check the link (the slug is the path segment after /online/), or find the restaurant with toast_find_restaurants near it.",
      });
    },
  );
}
