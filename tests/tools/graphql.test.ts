import { afterEach, describe, expect, it } from 'vitest';
import { ToastClient } from '../../src/client.js';
import { registerGraphqlTools } from '../../src/tools/graphql.js';
import { createTestHarness, parseToolResult, type TestHarness } from '../helpers.js';
import { FakeTransport, json } from '../fake-transport.js';

let h: TestHarness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

async function call(t: FakeTransport, args: Record<string, unknown>) {
  h = await createTestHarness((server) => registerGraphqlTools(server, new ToastClient(t)));
  return h.callTool('toast_graphql', args);
}

describe('toast_graphql', () => {
  it('runs a query and returns data plus errors', async () => {
    const t = new FakeTransport(() => json({ data: { a: 1 }, errors: [{ message: 'partial' }] }));
    const res = parseToolResult(await call(t, { query: 'query Q($x:Int){a(x:$x)}', variables: { x: 2 }, operation_name: 'Q' }));
    expect(res).toEqual({ data: { a: 1 }, errors: [{ message: 'partial' }] });
    const sent = new URL(t.requests[0].path, 'https://x.invalid').searchParams;
    expect(sent.get('variables')).toBe('{"x":2}');
    expect(sent.get('operationName')).toBe('Q');
  });

  it('refuses a mutation without sending anything', async () => {
    const t = new FakeTransport(() => json({ data: {} }));
    const res = await call(t, { query: 'mutation { placeOrder { id } }' });
    expect(res.isError).toBe(true);
    expect(t.requests).toHaveLength(0);
  });
});
