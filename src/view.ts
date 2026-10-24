import { minifiedResult, resolveView, viewParam, type View } from '@chrischall/mcp-utils';

/**
 * The `view` rungs this server honours (`@chrischall/mcp-utils` vocabulary).
 *
 * `compact` (default) is the shaped record from `parse.ts`: snake_case keys,
 * nulls for anything Toast did not send, computed `ordering_url` /
 * `distance_miles`. `full` is the gateway's `data` object untouched, for when
 * the shaped view looks wrong and the caller needs to see what Toast sent.
 */
export const TOAST_VIEWS = ['compact', 'full'] as const;

const NOTE =
  'compact (default) returns the shaped result; "full" returns the Toast gateway\'s raw `data` object untouched.';

export const viewArg = (): ReturnType<typeof viewParam> => viewParam(TOAST_VIEWS, { note: NOTE });

export function isFull(view: string | undefined): boolean {
  const rung: View = resolveView(view, TOAST_VIEWS);
  return rung === 'full';
}

/** Minified JSON result; only ever used by read tools. */
export const respond = (data: unknown): ReturnType<typeof minifiedResult> => minifiedResult(data);
