import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { ToastClient } from '../client.js';
import { DINING_OPTIONS, nearbyRestaurantsQuery } from '../graphql.js';
import { nameMatches, NEARBY_PAGE_CAP, shapeRestaurant, type Restaurant } from '../parse.js';
import { guidFromOrderingPage, parseToastReference } from '../urls.js';
import { isFull, respond, viewArg } from '../view.js';

const READ = { readOnlyHint: true, idempotentHint: true, openWorldHint: true } as const;

const latitude = z.number().min(-90).max(90).describe('Latitude of the search centre, decimal degrees.');
const longitude = z.number().min(-180).max(180).describe('Longitude of the search centre, decimal degrees.');
const radius = z
  .number()
  .min(0.1)
  .max(25)
  .default(2)
  .describe('Search radius in miles (0.1–25, default 2). Toast caps one answer at 299 restaurants.');

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
        "Find restaurants that take orders through Toast near a point (latitude/longitude — this server has no geocoder, so convert an address or city first). Returns each restaurant's GUID (what toast_get_menu needs), shortUrl, ordering link, address and distance, nearest first. Toast's directory lists restaurants OPEN for the dining option at `when` (default now): an empty or short result late at night means closed, not absent — retry with a daytime `when`. Optional `name` filters the results.",
      inputSchema: z.object({
        latitude,
        longitude,
        radius_miles: radius,
        name: z.string().optional().describe('Only restaurants whose name contains this (case/punctuation-insensitive).'),
        dining_option: z
          .enum(DINING_OPTIONS)
          .default('TAKE_OUT')
          .describe('TAKE_OUT (default; the verified value) or DELIVERY (accepted by the schema as far as is known, unverified).'),
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
      return respond({
        total: matched.length,
        returned: Math.min(limit, matched.length),
        ...(found.capped
          ? { note: `Toast returned its ${NEARBY_PAGE_CAP}-row maximum: the area may hold more. Narrow radius_miles to see them.` }
          : {}),
        ...(found.errors.length ? { warnings: found.errors.map((e) => e.message) } : {}),
        restaurants: matched.slice(0, limit),
      });
    },
  );

  server.registerTool(
    'toast_resolve_restaurant',
    {
      description:
        "Turn a Toast link, shortUrl, or GUID into the restaurant GUID that toast_get_menu needs. Handles order.toasttab.com/online/<shortUrl> links, toast.app links (r-<guid>), ?guid= parameters and bare GUIDs without any network call. A bare shortUrl has no GUID in it: pass latitude/longitude near the restaurant to look it up in Toast's directory (most reliable), otherwise the tool reads the restaurant's ordering page through your browser and accepts a GUID only if the page names exactly one.",
      inputSchema: z.object({
        reference: z.string().min(1).describe('A Toast ordering link, toast.app link, restaurant GUID, or shortUrl slug.'),
        latitude: latitude.optional(),
        longitude: longitude.optional(),
        radius_miles: radius,
      }),
      annotations: READ,
    },
    async ({ reference, latitude, longitude, radius_miles }) => {
      const ref = parseToastReference(reference);
      if (ref.guid) return respond({ guid: ref.guid, short_url: ref.shortUrl, resolved_by: 'reference' });
      const shortUrl = ref.shortUrl as string;

      if (latitude !== undefined && longitude !== undefined) {
        // Directory lookup. Noon local-ish time is not knowable here, so ask
        // "open now" first and, failing a hit, an instant 12h away — between
        // them one lands inside trading hours for almost every restaurant.
        for (const offsetHours of [0, 12]) {
          const when = new Date(Date.now() + offsetHours * 3_600_000).toISOString();
          const found = await findNearby(client, {
            latitude,
            longitude,
            radiusMiles: radius_miles,
            diningOption: 'TAKE_OUT',
            when,
          });
          const hit = found.restaurants.find((r) => r.short_url?.toLowerCase() === shortUrl);
          if (hit?.guid) return respond({ guid: hit.guid, short_url: shortUrl, resolved_by: 'directory', restaurant: hit });
        }
      }

      const html = await client.fetchText('order', `/online/${encodeURIComponent(shortUrl)}`);
      const guid = guidFromOrderingPage(html);
      if (guid) return respond({ guid, short_url: shortUrl, resolved_by: 'ordering_page' });
      return respond({
        guid: null,
        short_url: shortUrl,
        resolved_by: null,
        next_step:
          latitude === undefined
            ? 'Not resolved. Call again with latitude/longitude near the restaurant so it can be found in Toast\'s directory, or use toast_find_restaurants there.'
            : `Not found within ${radius_miles} mi of the given point, and the ordering page did not name a single restaurant GUID. Widen radius_miles or check the point is near the restaurant.`,
      });
    },
  );
}
