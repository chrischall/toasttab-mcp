import type { McpServer } from '@modelcontextprotocol/server';
import { registerBridgeHealthcheckTool, type BridgeHealthcheckTransport } from '@chrischall/mcp-utils/fetchproxy';
import type { ToastClient } from '../client.js';
import { GATEWAY_PATH } from '../client.js';
import { TYPENAME_QUERY } from '../graphql.js';
import type { ToastTransport } from '../transport.js';

/**
 * The probe is the cheapest request the real tools depend on: `{__typename}`
 * against the GraphQL gateway, relayed through an order.toasttab.com tab. A
 * robots.txt probe would pass while the gateway still said "Forbidden", which
 * is exactly the failure a healthcheck needs to name.
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
    probeFn: async () => {
      const { data } = await client.graphql(TYPENAME_QUERY);
      return JSON.stringify(data);
    },
  });
}
