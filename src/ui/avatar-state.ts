import type { CursorState } from "../desktop/avatar/CursorAvatar";
import { normalizeState } from "../desktop/avatar/expression";
import type { Bot } from "../core/contracts";

export function avatarState(bot: Pick<Bot, "mascotExpression" | "busy" | "unread">): CursorState {
  const pinned = typeof bot.mascotExpression === "string" ? normalizeState(bot.mascotExpression) : null;
  if (pinned) return pinned;
  return bot.busy ? "working" : bot.unread ? "notifying" : "idle";
}

export function avatarExpression(bot: Pick<Bot, "mascotExpression">): number | undefined {
  return typeof bot.mascotExpression === "number" ? bot.mascotExpression : undefined;
}
