import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { GraphqlError, ToastClient } from '../client.js';
import { menusQuery } from '../graphql.js';
import { filterMenus, mergeMenus, readMenus, type MenuSource } from '../parse.js';
import { parseToastReference } from '../urls.js';
import { isFull, respond, viewArg } from '../view.js';

export function registerMenuTools(server: McpServer, client: ToastClient): void {
  server.registerTool(
    'toast_get_menu',
    {
      description:
        "Get a Toast restaurant's menu: menus → groups → items with name, description, price, per-size prices and out-of-stock flag. `restaurant` is a GUID or any link that contains one (use toast_resolve_restaurant for a bare shortUrl). `source`: \"online\" (default) is what the restaurant sells through online ordering; \"pos\" is the register's full menu (often far larger); \"both\" merges them, listing each item once with the menus it appears on. `query` searches item names, descriptions and group names. Prices are the numbers Toast reports (dollars in Toast's other APIs; units not verified for this endpoint). Modifier/option prices are not available without an ordering session.",
      inputSchema: z.object({
        restaurant: z.string().min(1).describe('Restaurant GUID, or a Toast link containing one.'),
        source: z.enum(['online', 'pos', 'both']).default('online'),
        query: z.string().optional().describe('Only items whose name/description/group contains this (case-insensitive).'),
        include_out_of_stock: z.boolean().default(true).describe('Keep 86\'d items (flagged out_of_stock). Default true.'),
        limit: z.number().int().min(1).max(2000).default(200).describe('Max items to return (default 200).'),
        view: viewArg(),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ restaurant, source, query, include_out_of_stock, limit, view }) => {
      const ref = parseToastReference(restaurant);
      if (!ref.guid) {
        throw new Error(
          `"${restaurant}" has no restaurant GUID in it (shortUrl "${ref.shortUrl}"). Call toast_resolve_restaurant first, ideally with a latitude/longitude near the restaurant.`,
        );
      }
      const sources: MenuSource[] = source === 'both' ? ['online', 'pos'] : [source];
      const raw: Record<string, unknown> = {};
      const sets: Array<{ source: MenuSource; menus: unknown[] }> = [];
      const warnings: string[] = [];
      for (const s of sources) {
        const { data, errors } = await client.graphql(menusQuery(ref.guid, s === 'pos' ? 'POS' : 'ONLINE'));
        raw[s] = data;
        warnings.push(...errors.map((e: GraphqlError) => `${s}: ${e.message}`));
        const read = readMenus(data);
        if (!read) {
          const typename = (data as { menusV3?: { __typename?: string } }).menusV3?.__typename;
          warnings.push(`${s}: Toast answered with ${typename ?? 'an unexpected shape'} instead of a menu (wrong GUID, or online ordering is off for this restaurant).`);
          continue;
        }
        sets.push({ source: s, menus: read.menus });
      }
      if (isFull(view)) return respond({ guid: ref.guid, data: raw, ...(warnings.length ? { warnings } : {}) });

      const filtered = filterMenus(mergeMenus(sets), { query, includeOutOfStock: include_out_of_stock, limit });
      return respond({
        guid: ref.guid,
        source,
        total_items: filtered.total_items,
        returned: filtered.returned,
        truncated: filtered.truncated,
        ...(filtered.truncated ? { note: `Showing ${filtered.returned} of ${filtered.total_items} items; raise limit or narrow with query.` } : {}),
        ...(filtered.out_of_stock_hidden ? { out_of_stock_hidden: filtered.out_of_stock_hidden } : {}),
        ...(warnings.length ? { warnings } : {}),
        menus: filtered.menus,
      });
    },
  );
}
