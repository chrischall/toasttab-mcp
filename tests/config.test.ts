import { describe, expect, it } from 'vitest';
import { parsePort } from '../src/config.js';

describe('parsePort', () => {
  it('passes unset through and parses valid ports', () => {
    expect(parsePort(undefined)).toBeUndefined();
    expect(parsePort('  ')).toBeUndefined();
    expect(parsePort(' 40000 ')).toBe(40000);
  });

  it.each(['default', '0', '65536', '37149.5', '37149x'])('refuses %s, naming the variable', (v) => {
    expect(() => parsePort(v)).toThrow(/TOAST_WS_PORT/);
  });
});
