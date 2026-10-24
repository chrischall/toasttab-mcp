import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { ToastClient } from '../client.js';
import { assertReadOnlyDocument } from '../graphql.js';
import { respond } from '../view.js';

/**
 * The escape hatch, and the way this server grows. Only two gateway
 * operations are wired into dedicated tools because only two have a known
 * shape; this lets a caller (or the maintainer) try others — order history,
 * loyalty, gift cards — through the user's own browser and see real answers,
 * so a new dedicated tool can be built on a verified payload instead of a
 * guess. Queries only: anything containing a mutation or subscription is
 * refused before it leaves the process.
 */
export function registerGraphqlTools(server: McpServer, client: ToastClient): void {
  server.registerTool(
    'toast_graphql',
    {
      description:
        "Run a read-only GraphQL QUERY against Toast's online-ordering gateway (ws-api.toasttab.com/do-federated-gateway) through your signed-in browser, and return its raw data and errors. For exploring fields the dedicated tools don't cover yet. Mutations and subscriptions are refused. Known-good operations: nearbyRestaurants(input:{diningOption,fulfillmentDateTime,latitude,longitude,radius}) and menusV3(input:{restaurantGuid,visibility}). Validation errors name the fields the schema lacks — use them to correct the query rather than guessing repeatedly.",
      inputSchema: z.object({
        query: z.string().min(1).max(8000).describe('GraphQL document containing only queries/fragments.'),
        variables: z.record(z.string(), z.unknown()).optional().describe('Variables object, if the document declares any.'),
        operation_name: z.string().optional().describe('Which operation to run, if the document has several.'),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ query, variables, operation_name }) => {
      assertReadOnlyDocument(query);
      const { data, errors } = await client.graphql(query, { variables, operationName: operation_name });
      return respond({ data, ...(errors.length ? { errors } : {}) });
    },
  );
}
