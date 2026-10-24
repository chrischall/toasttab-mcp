# toasttab-mcp

MCP server for the **diner side** of [Toast](https://www.toasttab.com): it
finds restaurants that take orders through Toast and reads their menus. Every
request rides the user's own browser through the fetchproxy bridge
(`@fetchproxy/server` on 127.0.0.1:37149 + the ContextMint Bridge extension),
the same architecture as `opentable-mcp`. There is no direct mode, and the
reason is structural: `order.toasttab.com` serves a Cloudflare managed
challenge to server-side clients, and the GraphQL gateway answers them
`{"errors":[{"message":"Forbidden"}]}` (observed 2026-10-24 from a datacenter
IP). Don't add a direct path that tries to get past that.

**One entry point:** `src/index.ts` (stdio, the npm/mcpb package).

## Commands

```bash
npm run build   # tsc (tsconfig.check.json: src + tests) → esbuild → dist/bundle.js
npm test        # typecheck + vitest run (all mocked, no network)
```

No coverage threshold.

## Architecture

```
src/
  index.ts                 entry: FetchproxyTransport → ToastClient → runMcp
  version.ts               VERSION (the one x-release-please-version marker)
  transport.ts             ToastTransport interface ({host, path, GET} → {status, body, url})
  transport-fetchproxy.ts  relays ws-api requests via an order.toasttab.com tab (viaTab)
  session.ts               guest-session constants + sessionFromPage() (the gateway's auth)
  client.ts                ToastClient.graphql() over GET under a cached guest session + error mapping; fetchText()
  graphql.ts               query builders (inlined literals) + assertReadOnlyDocument
  parse.ts                 pure shaping: restaurants, menu merge/filter
  urls.ts                  link/shortUrl/GUID parsing, distance
  view.ts                  view: compact (shaped) | full (raw gateway data)
  tools/                   restaurants.ts, menus.ts, graphql.ts, healthcheck.ts
tests/                     FakeTransport drives the REAL ToastClient; roster.ts feeds the meta-tests
```

## Toast gateway facts

Live-verified 2026-10-24 through a bridged order.toasttab.com tab unless marked.

- Endpoint: `https://ws-api.toasttab.com/do-federated-gateway/v1/graphql`.
  CORS allows `https://order.toasttab.com` with credentials, which is why an
  ordering tab is the relay (`API_RELAY_TAB`). An API host can't relay its own
  requests: Chrome renders an error page there, and no content script can run
  in it. `www.toasttab.com` redirects to `toast.app`, so it is no relay either.
- **The gateway needs a guest session.** Without BOTH `toast-session-id` and
  `apollographql-client-name: sites-web-client` it answers
  `{"errors":[{"message":"Forbidden"}]}`, even in Toast's own tab with the
  user's cookies. A made-up session id is still Forbidden; another client
  name fails the CORS preflight. The id comes from
  `<div id="session" data-content="<base64 JSON {id,issuedAt,expiresAt}>"/>`,
  rendered on every order.toasttab.com page (padding written as `&#x3D;`),
  one-hour lifetime. `ToastClient` mints from `SESSION_PAGE_PATH`, a slug that
  404s (~12 KB, vs ~830 KB for a real menu page), re-mints 5 min before expiry,
  and on a Forbidden drops the session and retries exactly once.
- GET and POST both work once the headers are right. We use GET so every
  request is visibly a read. The SPA itself sends batched POSTs with persisted
  query hashes (`toast-persistent-query-hash`); we send plain documents and
  the gateway accepts them.
- **Introspection is disabled.** Field discovery is by validation errors
  ("Did you mean…") and by reading the SPA's server-rendered Apollo state
  (`window.__OO_STATE__` / `__APOLLO_STATE__` in the page HTML), whose cache
  keys name real operations and arguments.
- `nearbyRestaurants(input:{diningOption,fulfillmentDateTime,latitude,longitude,radius})`:
  `radius` is miles, results are restaurants **open at `fulfillmentDateTime`**,
  capped at **300** rows. `TAKE_OUT` and `DELIVERY` both work; DELIVERY is a
  subset (114 vs 196 within 2 mi of uptown Charlotte).
- `menusV3(input:{restaurantGuid[,visibility:POS]})` answers
  `__typename: "MenusResponse"`; no `visibility` is the online menu, `POS` the
  register menu (about 2× larger in the sample). **Prices are dollars**:
  `price: 12.5` is shown as $12.50 on the ordering page.
- `restaurantV2ByShortUrl(shortUrl:)` returns the union `RestaurantOrError`:
  `Restaurant {guid name shortUrl}` for a known slug, `GeneralError` (no other
  fields) for an unknown one. This is how `toast_resolve_restaurant` resolves a
  slug. Ordering pages are not scraped for a GUID: they embed sister locations'
  `restaurantGuid`s too, so no HTML rule can pick the right one.
- The nearby/menu selections first came from a third-party collector
  (tylerherman19/Coffee#10). One wrong field fails the whole query, so extend
  a selection only after `toast_graphql` has shown the field exists live.
- Arguments are **inlined literals**, because `$variables` need input type
  names that introspection would have given us. Strings go through `gqlString`
  (JSON.stringify), numbers through `gqlNumber`, and enums come from a closed
  list. Keep it that way: an un-escaped interpolation is a query-injection
  hole.

## Rules

- **Read-only server.** Every tool is `readOnlyHint: true`.
  `toast_graphql` refuses mutations and subscriptions before sending
  (`assertReadOnlyDocument`). A write tool (cart, order, loyalty) needs a
  confirmation gate (`@chrischall/mcp-utils` `requireConfirmationWithFallback`)
  and a live-captured payload first.
- Guest-account reads (order history, loyalty, gift cards) are the next
  features. Build each one from a payload captured via `toast_graphql` in a
  signed-in browser. Save a scrubbed copy as a fixture, and never invent the
  shape.
- Parsers degrade to nulls and empty arrays; they never throw on shape drift.
- `manifest.json` `tools[]` must equal the registered roster
  (`tests/manifest.test.ts`). Env keys are `TOAST_WS_PORT` plus the two
  fetchproxy reads.
- ESM + NodeNext: relative imports need `.js`. stdout is JSON-RPC only, so log
  to stderr.

## Pull requests & release notes

Fleet policy (Conventional-Commit PR titles, labels, auto-review / auto-merge,
release PRs) lives in `~/.claude/CLAUDE.md`. Shared conventions live in
[`chrischall/workflows`](https://github.com/chrischall/workflows)
`docs/fleet-conventions.md`. Versioning is release-please; never bump versions
by hand. `src/version.ts` plus the manifests listed in
`release-please-config.json` move together.
