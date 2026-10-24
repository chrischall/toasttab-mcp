---
name: toast
description: Find restaurants that order through Toast (toasttab.com) and read their menus via the toasttab-mcp server — "what can I order on Toast near me", "show the menu at this order.toasttab.com link", "is X out of stock", "does this place have vegetarian options". Requires toasttab-mcp and the ContextMint Bridge browser extension with an order.toasttab.com tab open.
---

# toasttab-mcp

Read-only access to Toast's diner side, relayed through the user's own browser.

## Workflow

1. **Find a restaurant.** `toast_find_restaurants` needs a latitude and longitude. This server has no geocoder, so convert the address or city first. Results list only places open for the dining option at `when` (default: now). An empty result late at night means "closed", not "none exist"; retry with a daytime `when`.
2. **Get its GUID.** Every directory result carries `guid`. For a link the user pasted, call `toast_resolve_restaurant`. Links containing `r-<guid>` or `?guid=` resolve with no network call. An `order.toasttab.com/online/<shortUrl>` link (or a bare shortUrl) is looked up in Toast by its slug.
3. **Read the menu.** `toast_get_menu` with `source`:
   - `online` (default): what can be ordered online.
   - `pos`: the full register menu, often much larger.
   - `both`: merged.

   Use `query` to search, and `include_out_of_stock: false` to hide sold-out items.

## Rules

- Report out-of-stock items as out of stock today, not as removed.
- Prices are dollars (`12.5` = $12.50). Modifier prices are not included.
- `truncated: true` means more items exist. Say so, or raise `limit`.
- On a "no order.toasttab.com tab", "Forbidden" or edge-block error, ask the user to open any restaurant's ordering page on `order.toasttab.com` in their browser and complete any check. Don't retry in a loop.
- `toast_graphql` is for exploration (read-only queries). Correct a query from the validation errors it returns. Don't guess field names repeatedly.
