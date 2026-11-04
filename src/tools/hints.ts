/**
 * Context-group hints, published on each tool as `_meta.mint` (the mcp-host
 * context-groups contract, core `mintHintSchema`). Inert data: a host that does
 * not read them sees an extra `_meta` key and nothing else. The shape is fixed
 * by the host's contract, so it is restated here rather than imported — this
 * server takes no dependency on mcp-host.
 *
 * Every tool here is in the `food` group. `aliases` are the words a person
 * says that a tool's name and description lack: lowercase, at most 8, each at
 * most 40 chars. No tool names a `subject` — the server reads ONE signed-in
 * toast.app account and has no listable set of people or places to fan out
 * over — and none names `when`, because Toast pages its order history by
 * token rather than by date range.
 */
export type MintIntent =
  | 'whats-new' | 'whats-due' | 'whats-on' | 'lookup' | 'turn-on-off' | 'send' | 'change' | 'other';

export interface MintHint {
  domain: 'food';
  intent: MintIntent;
  canonical?: true;
  subject?: string;
  when?: { start: string; end: string };
  aliases?: string[];
}

/** `_meta` for a Toast tool. */
export function foodMeta(intent: MintIntent, extra: Omit<MintHint, 'domain' | 'intent'> = {}): { mint: MintHint } {
  return { mint: { domain: 'food', intent, ...extra } };
}
