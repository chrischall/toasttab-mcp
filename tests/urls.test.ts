import { describe, expect, it } from 'vitest';
import { guidFromOrderingPage, milesBetween, orderingUrl, parseToastReference } from '../src/urls.js';
import { GUID_A, GUID_B } from './fake-transport.js';

describe('parseToastReference', () => {
  it('accepts a bare GUID (lowercased)', () => {
    expect(parseToastReference(GUID_A.toUpperCase())).toEqual({ guid: GUID_A, shortUrl: null });
  });

  it('accepts a bare shortUrl', () => {
    expect(parseToastReference('Mad-Rooster-Milwaukee')).toEqual({ guid: null, shortUrl: 'mad-rooster-milwaukee' });
  });

  it('reads the shortUrl from an ordering link', () => {
    expect(parseToastReference('https://order.toasttab.com/online/joes-pizza/item-x')).toEqual({ guid: null, shortUrl: 'joes-pizza' });
    expect(parseToastReference('www.toasttab.com/joes-pizza')).toEqual({ guid: null, shortUrl: 'joes-pizza' });
  });

  it('takes a ?guid= alongside the shortUrl', () => {
    expect(parseToastReference(`https://order.toasttab.com/online/joes-pizza?guid=${GUID_B}`)).toEqual({ guid: GUID_B, shortUrl: 'joes-pizza' });
  });

  it('reads r-<guid> from a toast.app deep link', () => {
    expect(parseToastReference(`https://toast.app/r/joes/order/r-${GUID_A}`)).toEqual({ guid: GUID_A, shortUrl: null });
  });

  it('refuses other hosts and empty links', () => {
    expect(() => parseToastReference('https://example.com/online/joes')).toThrow(/Not a Toast link/);
    expect(() => parseToastReference('https://order.toasttab.com/online/')).toThrow(/Could not find/);
    expect(() => parseToastReference('online')).toThrow();
    expect(() => parseToastReference('http://[bad')).toThrow(/Not a Toast/);
  });
});

describe('guidFromOrderingPage', () => {
  it('accepts exactly one distinct restaurantGuid, plain or escaped JSON', () => {
    expect(guidFromOrderingPage(`{"restaurantGuid":"${GUID_A}","x":1,"restaurantGuid":"${GUID_A}"}`)).toBe(GUID_A);
    expect(guidFromOrderingPage(`"{\\"restaurantGuid\\":\\"${GUID_A}\\"}"`)).toBe(GUID_A);
  });

  it('refuses zero or several, and ignores other keys', () => {
    expect(guidFromOrderingPage(`{"guid":"${GUID_A}"}`)).toBeNull();
    expect(guidFromOrderingPage(`{"restaurantGuid":"${GUID_A}","restaurantGuid":"${GUID_B}"}`)).toBeNull();
  });
});

describe('helpers', () => {
  it('builds ordering links and distances', () => {
    expect(orderingUrl('joes-pizza')).toBe('https://order.toasttab.com/online/joes-pizza');
    expect(milesBetween(35.2271, -80.8431, 35.2271, -80.8431)).toBe(0);
    // Charlotte → Raleigh, ~130 mi as the crow flies.
    expect(milesBetween(35.2271, -80.8431, 35.7796, -78.6382)).toBeGreaterThan(125);
    expect(milesBetween(35.2271, -80.8431, 35.7796, -78.6382)).toBeLessThan(135);
  });
});
