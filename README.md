# Toast MCP

[![CI](https://github.com/chrischall/toasttab-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/chrischall/toasttab-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/toasttab-mcp)](https://www.npmjs.com/package/toasttab-mcp)
[![license](https://img.shields.io/npm/l/toasttab-mcp)](LICENSE)

A [Model Context Protocol](https://modelcontextprotocol.io) server that connects Claude to the diner side of [Toast](https://www.toasttab.com). It finds restaurants that take orders through Toast and reads their menus, and, when you are signed in to [toast.app](https://toast.app), reads your own order history, loyalty programs and Toast Cash.

> [!WARNING]
> **AI-developed project.** Claude Code built this codebase and maintains it, and no human has audited the implementation. Review the code and tool permissions before you use it.

## What you can do

- *"Which restaurants near me can I order takeout from on Toast right now?"*
- *"What's on the menu at https://order.toasttab.com/online/…? Anything vegetarian under $12?"*
- *"Is the oat-milk latte at that café out of stock today?"*
- *"Compare the online menu with the full in-store menu."*
- *"What did I order from that Thai place last week, and what did it cost?"*
- *"How close am I to a reward at my coffee shop? What's my Toast Cash balance?"*

## How it works

Toast's diner-facing sites (`order.toasttab.com`) and its ordering GraphQL gateway (`ws-api.toasttab.com/do-federated-gateway`) sit behind Cloudflare. Cloudflare refuses server-side clients: it serves a challenge page, or the gateway answers `{"errors":[{"message":"Forbidden"}]}`. This server therefore makes **no direct requests**. Every call goes through your own browser via the [ContextMint Bridge](https://github.com/nullnet-app/contextmint-bridge/releases) extension, using [`@fetchproxy/server`](https://github.com/chrischall/fetchproxy) on `127.0.0.1:37149`. You pass any "verify you are human" check yourself, in your own tab. Nothing is bypassed.

## Tools

| Tool | What it does |
| --- | --- |
| `toast_find_restaurants` | Restaurants near a latitude/longitude that are open for takeout (or delivery) at a given time, nearest first. Each result includes its GUID, shortUrl, ordering link, address and distance. |
| `toast_resolve_restaurant` | Turns a Toast link, shortUrl or GUID into the restaurant GUID that `toast_get_menu` needs. |
| `toast_get_menu` | Reads the online-ordering menu, the full register (POS) menu, or both merged. Supports search, out-of-stock filtering and a limit. |
| `toast_list_orders` | Your order history, newest first: restaurant, time, dining option, status, items and total. Pages with `next_page_token`. |
| `toast_get_order` | One past order as a receipt: items with modifiers, subtotal, tax, tip, service charges, payments and delivery details. |
| `toast_get_loyalty` | Your restaurant loyalty programs: balances and progress toward the next reward. |
| `toast_get_wallet` | Your Toast Cash: balance, next expiry, expiring units and received units (gifts name the sender). |
| `toast_graphql` | Runs a read-only GraphQL query against the gateway, for exploring data the other tools don't cover. Mutations are refused. |
| `toast_healthcheck` | Round-trips the bridge and gateway, and names the hop that failed. |

All of these tools are read-only. None of them places an order, touches a cart, redeems a reward or changes your account. The four account tools (`toast_list_orders`, `toast_get_order`, `toast_get_loyalty`, `toast_get_wallet`) work only while you are signed in to toast.app in the bridged browser.

### What is verified and what isn't

The operations behind the dedicated tools (`nearbyRestaurants`, `menusV3` and `restaurantV2ByShortUrl`) were live-verified on 2026-10-24 through a bridged browser. Menu prices are in dollars, and both `TAKE_OUT` and `DELIVERY` work. The gateway only answers requests that carry a guest session, which the server mints itself from an order.toasttab.com page through your browser, so you don't need to do anything beyond keeping that tab open.

The account tools run Toast's own guest-app queries (copied verbatim from toast.app's bundle), and every shape they parse was captured live and kept, scrubbed, as a test fixture. They authenticate with your toast.app access token, which the bridge reads from that one cookie for each call. The server never refreshes the token (refreshing rotates it and would sign your browser out), so if it has lapsed you'll be asked to reload toast.app. Saved payment methods and the account profile are deliberately not exposed.

## Install

1. Install the **ContextMint Bridge** extension from its [releases page](https://github.com/nullnet-app/contextmint-bridge/releases). Chrome takes the unpacked zip.
2. Open any restaurant's ordering page on `https://order.toasttab.com` and leave the tab open. It relays the API calls.
   For the account tools, also keep a signed-in `https://toast.app` tab open.
3. Add the server to your MCP client:

```json
{
  "mcpServers": {
    "toast": { "command": "npx", "args": ["-y", "toasttab-mcp"] }
  }
}
```

Node 22 or later is required. No credentials are configured here. On first run, the extension asks you to approve the pairing. It lists toasttab.com and toast.app, and a read of the `toast-customer-access` cookie for the account tools.

### Configuration (all optional)

| Variable | Default | Purpose |
| --- | --- | --- |
| `TOAST_WS_PORT` | `37149` | Bridge WebSocket port |
| `FETCHPROXY_WS_HOST` | `127.0.0.1` | Bridge bind interface (hosted setups only) |
| `FETCHPROXY_IDENTITY_DIR` | `~/.fetchproxy/identity/` | Bridge identity keypair location |

## Troubleshooting

Run `toast_healthcheck` first.

- **"Forbidden"** or **"edge … refused"**: your browser hasn't passed Toast's Cloudflare check yet. Open `order.toasttab.com`, let it load (complete any check), then retry.
- **"No order.toasttab.com tab is open"**: open any `order.toasttab.com/online/<restaurant>` page in the browser that runs the extension.
- **"not signed in" / "sign-in has expired"** (account tools): open or reload `toast.app` and sign in, then retry.
- **Directory comes back empty at night**: `nearbyRestaurants` lists only restaurants open at `when`. Pass a daytime `when`.

## Acknowledgement of terms

This server reaches Toast as **you**, through your browser, so Toast's guest terms of service govern how you use it. The maintainer has not reviewed those terms against this use. Read them yourself before you rely on this server. The project is not affiliated with or endorsed by Toast, Inc. It is for personal use: don't use it to bulk-harvest restaurant data.

## Development

```bash
npm install
npm test        # typecheck + vitest (all mocked, no network)
npm run build   # typecheck + esbuild bundle → dist/bundle.js
```

## License

MIT
