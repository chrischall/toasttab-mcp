import { describe, expect, it } from 'vitest';
import { registeredTools } from './roster.js';

describe('every tool declares its annotations', () => {
  const tools = registeredTools();

  it('registers the full surface', () => {
    expect(tools.map((t) => t.name).sort()).toEqual([
      'toast_find_restaurants',
      'toast_get_loyalty',
      'toast_get_menu',
      'toast_get_order',
      'toast_get_wallet',
      'toast_graphql',
      'toast_healthcheck',
      'toast_list_orders',
      'toast_resolve_restaurant',
    ]);
  });

  it('is read-only and open-world throughout (this server has no writes)', () => {
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint, t.name).toBe(true);
      expect(t.annotations?.destructiveHint, t.name).not.toBe(true);
      expect(t.annotations?.openWorldHint, t.name).toBe(true);
    }
  });
});
