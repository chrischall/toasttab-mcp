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
  config.ts                parsePort (TOAST_WS_PORT, fails loudly on a bad value)
  transport.ts             ToastTransport interface ({host, path, GET} → {status, body, url})
  transport-fetchproxy.ts  relays ws-api requests via an order.toasttab.com tab (viaTab)
  session.ts               gateway-session constants + sessionFromPage() / sessionFromFlightData()
  client.ts                ToastClient.graphql() (public) / guestGraphql() (signed-in) over GET, per-site session cache, error mapping
  graphql.ts               query builders (inlined literals) + assertReadOnlyDocument
  parse.ts                 pure shaping: restaurants, menu merge/filter
  urls.ts                  link/shortUrl/GUID parsing, distance
  view.ts                  view: compact (shaped) | full (raw gateway data)
  guest-documents.ts       toast.app's own guest-account query documents (verbatim)
  tools/                   restaurants.ts, menus.ts, graphql.ts, account.ts, healthcheck.ts
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

## Signed-in guest (toast.app)

Live-verified 2026-10-24 from a signed-in toast.app tab.

- toast.app is a Next.js app (`capman-guest-app`). The account pages render
  server-side, but the browser also calls the same gateway directly, as
  Apollo client **`capman-guest-app-browser`**.
- A guest read needs THREE headers: that client name, a **toast.app-issued**
  `toast-session-id` (an order.toasttab.com session under this client name
  is Forbidden, and vice versa), and `Authorization: Bearer <toast-customer-access>`.
  Without the bearer the gateway answers 200 with
  "You are not permitted to call guest".
- toast.app renders its session into the RSC flight data
  (`{\"id\",\"issuedAt\",\"expiresAt\"}`, one hour) on every page,
  a 404 included (`GUEST_SESSION_PAGE_PATH`).
- Tokens live in **page-readable cookies**: `toast-customer-access` (JWT,
  about 30 min) and `toast-customer-refresh`. Refreshing is the mutation
  `passwordlessRefreshToken`, which rotates the refresh token. This server
  declares ONLY the access cookie (`read_cookies` + `cookieKeys`), reads it
  per call, and never refreshes. A missing or lapsed token is a
  `ToastSignedOutError` telling the user to reload toast.app.
- Guest requests relay through a toast.app tab (`relay: 'app'`), with
  `domain: 'toast.app'` on every fetchproxy call (multi-domain servers must
  name the domain).
- Introspection is off, but toast.app's bundle holds a persisted-query map,
  hash → full document with fragments inlined (97 operations, about half of
  them mutations). The documents in `guest-documents.ts` come from there.
- Units: order money is **dollars as numbers** (`totalV2: 110.52`, shown as
  $110.52). Wallet money is **dollar decimal strings** (`"9.99"`), converted
  to numbers by `parse.ts`. `openedDateTime` is **epoch milliseconds**.
- `diningOptionBehavior` is Toast's raw value and does not match toast.app's
  label: an order shown as "Delivery" carried `TAKE_OUT` plus a `deliveryInfo`
  address. Report it verbatim.
- Not yet observed with data: Toast Cash expiring/received units (the
  account had none), so the gift-unit row shape is Toast's document only.
  `GetGuestCurrencyExpirableUnits` takes an optional `PageInput` whose fields
  are unknown, so it is sent without one.

## Rules

- **Read-only server.** Every tool is `readOnlyHint: true`. `toast_graphql`
  runs public-only (order.toasttab.com session, no bearer). Don't give it the
  guest's token: a read-only check is not a reason to hand an arbitrary
  document the user's account.
  `toast_graphql` refuses mutations and subscriptions before sending
  (`assertReadOnlyDocument`). A write tool (cart, order, loyalty) needs a
  confirmation gate (`@chrischall/mcp-utils` `requireConfirmationWithFallback`)
  and a live-captured payload first.
- Guest-account reads come from `src/guest-documents.ts`: documents copied
  verbatim from toast.app's persisted-query map, each parsed shape captured
  live and kept scrubbed in `tests/fixtures/guest/`. Add a read the same way:
  take the document from the bundle (never write field names yourself),
  capture a payload, scrub it in the page before it leaves the browser,
  fixture it. `tests/guest-documents.test.ts` fails on any non-query.
- Saved payment methods, the profile/addresses query and `getSpiBearerToken`
  are deliberately not exposed, even read-only.
- Parsers degrade to nulls and empty arrays; they never throw on shape drift.
- `manifest.json` `tools[]` must equal the registered roster
  (`tests/manifest.test.ts`). Changing fetchproxy `domains`, `capabilities`
  or `cookieKeys` forces every user to re-pair, so only change them
  deliberately. Env keys are `TOAST_WS_PORT` plus the two fetchproxy reads.
- ESM + NodeNext: relative imports need `.js`. stdout is JSON-RPC only, so log
  to stderr.

## Pull requests & release notes

Fleet policy (Conventional-Commit PR titles, labels, auto-review / auto-merge,
release PRs) lives in `~/.claude/CLAUDE.md`. Shared conventions live in
[`chrischall/workflows`](https://github.com/chrischall/workflows)
`docs/fleet-conventions.md`. Versioning is release-please; never bump versions
by hand. `src/version.ts` plus the manifests listed in
`release-please-config.json` move together.
