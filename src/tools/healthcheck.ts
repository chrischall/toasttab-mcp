import type { McpServer } from '@modelcontextprotocol/server';
import { registerBridgeHealthcheckTool, type BridgeHealthcheckTransport } from '@chrischall/mcp-utils/fetchproxy';
import type { ToastClient } from '../client.js';
import { GATEWAY_PATH } from '../client.js';
import { TYPENAME_QUERY } from '../graphql.js';
import type { ToastTransport } from '../transport.js';

/**
 * The probe is the cheapest request the real tools depend on: `{__typename}`
 * against the GraphQL gateway under a guest session, relayed through an
 * order.toasttab.com tab. A robots.txt probe would pass while the gateway
 * still said "Forbidden", which is exactly the failure a healthcheck needs to
 * name.
 */
const PROBE_PATH = `${GATEWAY_PATH}?query=${encodeURIComponent(TYPENAME_QUERY)}`;

export function registerHealthcheckTools(server: McpServer, client: ToastClient, transport: ToastTransport): void {
  const { runProbe, bridgeStatus } = transport;
  if (!runProbe || !bridgeStatus) return;
  registerBridgeHealthcheckTool({
    server,
    prefix: 'toast',
    probePath: PROBE_PATH,
    hostLabel: 'ws-api.toasttab.com',
    transport: {
      runProbe: (fetchFn, probePath) => runProbe.call(transport, fetchFn, probePath) as never,
      status: () => bridgeStatus.call(transport) as never,
    } satisfies BridgeHealthcheckTransport,
    // The library's copy names `hostLabel` (the API host) as the tab to open
    // and sign in to. Neither applies: an API host can never hold a relaying
    // tab, and nothing here needs a sign-in.
    hints: {
      protocol:
        'The bridge returned a protocol error before any HTTP response. Most commonly no order.toasttab.com tab is open: open any restaurant\'s ordering page (https://order.toasttab.com/online/<restaurant>) in the browser running ContextMint Bridge, then retry.',
      timeout:
        'Bridge is alive, but the request got no response in time. Either ContextMint Bridge is not connected to this MCP yet (check the popup for a green dot next to toasttab-mcp), or the order.toasttab.com tab is asleep or closed: reload it, then retry.',
    },
    probeFn: async () => {
      const { data } = await client.graphql(TYPENAME_QUERY);
      return JSON.stringify(data);
    },
  });
}
