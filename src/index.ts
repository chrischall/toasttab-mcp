#!/usr/bin/env node
// toasttab-mcp entrypoint.
//
// Toast's diner-facing surfaces (order.toasttab.com and its GraphQL gateway)
// sit behind Cloudflare, so every request rides the user's own browser through
// the fetchproxy bridge: @fetchproxy/server listens on 127.0.0.1:37149 and the
// ContextMint Bridge extension (installed separately) relays from a
// toasttab.com tab.
import { readEnvVar, runMcp } from '@chrischall/mcp-utils';
import { ToastClient } from './client.js';
import { FetchproxyTransport } from './transport-fetchproxy.js';
import { registerRestaurantTools } from './tools/restaurants.js';
import { registerMenuTools } from './tools/menus.js';
import { registerGraphqlTools } from './tools/graphql.js';
import { registerAccountTools } from './tools/account.js';
import { registerHealthcheckTools } from './tools/healthcheck.js';
import { VERSION } from './version.js';

const wsPort = readEnvVar('TOAST_WS_PORT');
const transport = new FetchproxyTransport({ port: wsPort ? Number(wsPort) : undefined, version: VERSION });

// Start before the server so tools/list always answers and the first tool
// call is what surfaces a bridge problem.
const client = new ToastClient(transport);
await client.start();

await runMcp({
  name: 'toasttab-mcp',
  version: VERSION,
  banner:
    `[toasttab-mcp] v${VERSION} — WebSocket bridge via @fetchproxy/server on 127.0.0.1:${wsPort ?? 37149}. ` +
    'Install the ContextMint Bridge extension (https://github.com/nullnet-app/contextmint-bridge/releases) and ' +
    'keep an order.toasttab.com tab open (and a signed-in toast.app tab for your orders, loyalty and Toast Cash). This server is built and maintained by AI (Claude Code); review before use.',
  deps: client,
  tools: [
    registerRestaurantTools,
    registerMenuTools,
    registerGraphqlTools,
    registerAccountTools,
    (server) => registerHealthcheckTools(server, client, transport),
  ],
  shutdown: { onSignal: () => client.close() },
});
