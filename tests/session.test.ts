import { describe, expect, it } from 'vitest';
import { sessionFromPage } from '../src/session.js';
import { SESSION_ID, sessionPage } from './fake-transport.js';

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');

describe('sessionFromPage', () => {
  it('reads the live page shape: self-closing div, entity-escaped base64 padding', () => {
    expect(sessionFromPage(sessionPage().body)).toEqual({ id: SESSION_ID, expiresAt: Date.parse('2099-01-01T01:00:00Z') });
  });

  it('accepts the attributes in either order and plain padding', () => {
    const content = encode({ id: 'abc', expiresAt: '2099-01-01T00:00:00Z' });
    expect(sessionFromPage(`<div data-content="${content}" id="session"></div>`)?.id).toBe('abc');
  });

  it('returns null without a session element, or when it does not decode to {id, expiresAt}', () => {
    expect(sessionFromPage('<html><body>nothing</body></html>')).toBeNull();
    expect(sessionFromPage('<div id="session"/>')).toBeNull();
    expect(sessionFromPage('<div id="session" data-content="!!!not base64 json"/>')).toBeNull();
    expect(sessionFromPage(`<div id="session" data-content="${encode({ expiresAt: '2099-01-01T00:00:00Z' })}"/>`)).toBeNull();
    expect(sessionFromPage(`<div id="session" data-content="${encode({ id: 'abc', expiresAt: 'soon' })}"/>`)).toBeNull();
  });

  it('ignores a data-content on some other element', () => {
    const content = encode({ id: 'abc', expiresAt: '2099-01-01T00:00:00Z' });
    expect(sessionFromPage(`<div id="other" data-content="${content}"/><div id="session"/>`)).toBeNull();
  });
});
