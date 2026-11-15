// Copyright OpenMausBot contributors. Apache-2.0; see third_party/OpenMausBot-LICENSE.
import { CURSOR_STATES, type CursorState } from './CursorAvatar';
import { mascotExpressionSchema } from './bot-avatar';
type MausState = CursorState;
const LEGACY_STATES: Record<string, MausState> = {
  deadpan: "idle",
  friendly: "happy",
  focused: "working",
  thinking: "thinking",
  excited: "excited",
  sleepy: "drowsy",
  surprised: "surprised",
  skeptical: "suspicious",
  worried: "scared",
  mischievous: "playful",
};

const KNOWN_STATES = new Set<string>(CURSOR_STATES);

export function normalizeState(value: string | null | undefined): MausState | null {
  const expression = mascotExpressionSchema.safeParse(value).data;
  if (!expression) return null;
  if (KNOWN_STATES.has(expression)) return expression as MausState;
  return LEGACY_STATES[expression] ?? null;
}
