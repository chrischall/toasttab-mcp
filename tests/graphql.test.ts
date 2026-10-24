import { describe, expect, it } from 'vitest';
import { assertReadOnlyDocument, gqlNumber, gqlString, menusQuery, nearbyRestaurantsQuery, restaurantByShortUrlQuery } from '../src/graphql.js';

describe('literal builders', () => {
  it('escapes strings so input cannot break out of the literal', () => {
    expect(gqlString('a"b\\c\n')).toBe('"a\\"b\\\\c\\n"');
    expect(menusQuery('x"}){evil}#', 'ONLINE')).toContain('restaurantGuid:"x\\"}){evil}#"');
    expect(restaurantByShortUrlQuery('x"){evil}#')).toContain('shortUrl:"x\\"){evil}#"');
  });

  it('refuses non-finite numbers', () => {
    expect(() => gqlNumber(Number.NaN)).toThrow(/finite/);
    expect(gqlNumber(-80.8431)).toBe('-80.8431');
  });

  it('builds the observed nearbyRestaurants shape', () => {
    expect(
      nearbyRestaurantsQuery({
        latitude: 35.2271,
        longitude: -80.8431,
        radiusMiles: 3,
        diningOption: 'TAKE_OUT',
        fulfillmentDateTime: '2026-10-24T16:00:00.000Z',
      }),
    ).toBe(
      '{nearbyRestaurants(input:{diningOption:TAKE_OUT,fulfillmentDateTime:"2026-10-24T16:00:00.000Z",latitude:35.2271,longitude:-80.8431,radius:3}){guid name shortUrl location{address1 city state latitude longitude}}}',
    );
  });

  it('rejects a dining option outside the closed list', () => {
    expect(() =>
      nearbyRestaurantsQuery({ latitude: 0, longitude: 0, radiusMiles: 1, diningOption: 'X){a}' as never, fulfillmentDateTime: '' }),
    ).toThrow(/dining option/);
  });

  it('omits visibility for ONLINE and sends POS literally', () => {
    expect(menusQuery('g', 'ONLINE')).not.toContain('visibility');
    expect(menusQuery('g', 'POS')).toContain(',visibility:POS}');
  });
});

describe('assertReadOnlyDocument', () => {
  it.each([
    '{__typename}',
    'query { a }',
    'query Q($x: String) { a(x: $x) { b } } fragment F on T { c }',
    '{ mutation { x } }', // a FIELD named mutation is fine
    'query { a(s: "mutation { x }") }',
    '# mutation { x }\nquery { a }',
    'query { a(s: """block # with mutation { x } inside""") }',
    'query { a(s: "quote # not a comment") } # mutation',
  ])('allows %s', (doc) => {
    expect(() => assertReadOnlyDocument(doc)).not.toThrow();
  });

  it.each([
    'mutation { addToCart { id } }',
    'query { a } mutation M { b }',
    'subscription { orders }',
    '  mutation\n{ x }',
    // A block-string quote inside a comment must not hide what follows it.
    'query Q { __typename } # """\nmutation M { placeOrder { id } }\n# """',
    'query Q { a } # """\nmutation M { b(s: """x""") { id } }',
  ])('refuses %s', (doc) => {
    expect(() => assertReadOnlyDocument(doc)).toThrow(/read-only/);
  });

  it('refuses malformed documents', () => {
    expect(() => assertReadOnlyDocument('{ a ')).toThrow(/Unbalanced/);
    expect(() => assertReadOnlyDocument('}{')).toThrow(/Unbalanced/);
    expect(() => assertReadOnlyDocument('query')).toThrow(/No GraphQL operation/);
  });
});
