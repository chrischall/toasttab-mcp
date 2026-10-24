import { describe, expect, it } from 'vitest';
import { filterMenus, mergeMenus, nameMatches, readMenus, shapeRestaurant } from '../src/parse.js';

const item = (guid: string | null, name: string, extra: Record<string, unknown> = {}) => ({
  guid, name, description: null, price: 4.5, prices: [], outOfStock: false, ...extra,
});

describe('shapeRestaurant', () => {
  it('shapes a row and computes distance + ordering link', () => {
    const r = shapeRestaurant(
      { guid: 'g', name: 'Joe’s', shortUrl: 'joes', location: { address1: '1 Main', city: 'Charlotte', state: 'NC', latitude: 35.23, longitude: -80.84 } },
      { latitude: 35.2271, longitude: -80.8431 },
    );
    expect(r).toMatchObject({ guid: 'g', short_url: 'joes', ordering_url: 'https://order.toasttab.com/online/joes', city: 'Charlotte' });
    expect(r.distance_miles).toBeGreaterThan(0);
    expect(r.distance_miles).toBeLessThan(1);
  });

  it('degrades to nulls on junk, never throws', () => {
    expect(shapeRestaurant(null)).toMatchObject({ guid: null, ordering_url: null, distance_miles: null });
    expect(shapeRestaurant({ location: [] }, { latitude: 0, longitude: 0 }).distance_miles).toBeNull();
  });
});

describe('nameMatches', () => {
  it('ignores case and punctuation', () => {
    expect(nameMatches("Joe’s Pizza & Subs", 'joes pizza')).toBe(true);
    expect(nameMatches("Joe's Pizza & Subs", 'pizza subs')).toBe(true);
    expect(nameMatches('Anything', '  ')).toBe(true);
    expect(nameMatches(null, 'x')).toBe(false);
  });
});

describe('readMenus', () => {
  it('reads menus, treats a missing list as empty, and flags an error arm', () => {
    expect(readMenus({ menusV3: { __typename: 'MenusResponse', menus: [1] } })).toEqual({ menus: [1], typename: 'MenusResponse' });
    expect(readMenus({ menusV3: {} })).toEqual({ menus: [], typename: null });
    expect(readMenus({ menusV3: { __typename: 'MenusErrorResponse' } })).toBeNull();
  });
});

describe('mergeMenus / filterMenus', () => {
  const online = [{ name: 'Lunch', groups: [{ name: 'Coffee', items: [item('a', 'Latte', { prices: [4, 5] , price: null }), item('b', 'Mocha')] }, { name: 'Empty', items: [] }] }];
  const pos = [{ name: 'Register', groups: [{ name: 'Coffee', items: [item('a', 'Latte'), item('c', 'Espresso', { outOfStock: true }), item(null, 'Mystery')] }] }];

  it('lists each GUID once with every source it came from', () => {
    const merged = mergeMenus([{ source: 'online', menus: online }, { source: 'pos', menus: pos }]);
    expect(merged.map((m) => m.name)).toEqual(['Lunch', 'Register']);
    expect(merged[0].groups).toHaveLength(1); // empty group dropped
    expect(merged[0].groups[0].items[0]).toMatchObject({ guid: 'a', price: null, prices: [4, 5], sources: ['online', 'pos'] });
    expect(merged[1].groups[0].items.map((i) => i.name)).toEqual(['Espresso', 'Mystery']);
  });

  it('filters by query (name, description, group), stock and limit', () => {
    const merged = mergeMenus([{ source: 'online', menus: online }, { source: 'pos', menus: pos }]);
    expect(filterMenus(merged, { query: 'latte', includeOutOfStock: true, limit: 10 })).toMatchObject({ total_items: 1, returned: 1, truncated: false });
    expect(filterMenus(merged, { query: 'COFFEE', includeOutOfStock: true, limit: 10 }).total_items).toBe(4);
    const noStock = filterMenus(merged, { includeOutOfStock: false, limit: 2 });
    expect(noStock).toMatchObject({ total_items: 3, returned: 2, truncated: true, out_of_stock_hidden: 1 });
  });
});
