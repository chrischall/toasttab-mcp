import { describe, expect, it } from 'vitest';
import * as docs from '../src/guest-documents.js';
import { assertReadOnlyDocument } from '../src/graphql.js';

const ops = Object.values(docs).filter((v): v is docs.GuestOperation => typeof v === 'object' && v !== null && 'document' in v);

describe('guest documents', () => {
  it('holds the six account reads', () => {
    expect(ops.map((o) => o.name).sort()).toEqual([
      'capmanGuestApp_GetCompletedOrder',
      'capmanGuestApp_GetGuestCurrencyExpirableUnits',
      'capmanGuestApp_GetGuestCurrencyReceivedUnits',
      'capmanGuestApp_GetGuestOrderHistory',
      'capmanGuestApp_GetGuestRewards',
      'capmanGuestApp_GetGuestWallet',
    ]);
  });

  it('are all queries — Toast keeps its mutations in the same map', () => {
    for (const op of ops) expect(() => assertReadOnlyDocument(op.document), op.name).not.toThrow();
  });

  it('each name the operation its document defines, as the gateway expects', () => {
    for (const op of ops) expect(op.document, op.name).toContain(`query ${op.name}`);
  });
});
