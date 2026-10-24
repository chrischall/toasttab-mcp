// Registers every tool against a recording stub, so meta-tests read the
// REAL registered surface rather than a hand-kept list.
import type { ToastClient } from '../src/client.js';
import type { ToastTransport } from '../src/transport.js';
import { registerRestaurantTools } from '../src/tools/restaurants.js';
import { registerMenuTools } from '../src/tools/menus.js';
import { registerGraphqlTools } from '../src/tools/graphql.js';
import { registerAccountTools } from '../src/tools/account.js';
import { registerHealthcheckTools } from '../src/tools/healthcheck.js';

export interface Registered {
  name: string;
  annotations?: { readOnlyHint?: unknown; destructiveHint?: unknown; openWorldHint?: unknown };
}

export function registeredTools(): Registered[] {
  const seen: Registered[] = [];
  const server = {
    registerTool: (name: string, cfg: { annotations?: Registered['annotations'] }) => void seen.push({ name, annotations: cfg.annotations }),
  } as never;
  const client = {} as ToastClient;
  const transport = { runProbe: async () => undefined, bridgeStatus: () => undefined } as unknown as ToastTransport;
  registerRestaurantTools(server, client);
  registerMenuTools(server, client);
  registerGraphqlTools(server, client);
  registerAccountTools(server, client);
  registerHealthcheckTools(server, client, transport);
  return seen;
}
