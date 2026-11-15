import { expect, it } from "vitest";
import { avatarExpression, avatarState } from "../src/ui/avatar-state";

it("uses the desktop's named expression as an animation state and preserves numeric caches", () => {
  expect(avatarState({ mascotExpression: "proud", busy: false, unread: false })).toBe("proud");
  expect(avatarState({ mascotExpression: "happy", busy: true, unread: true })).toBe("happy");
  expect(avatarState({ mascotExpression: "future-expression", busy: true, unread: false })).toBe("working");
  expect(avatarState({ mascotExpression: null, busy: false, unread: true })).toBe("notifying");
  expect(avatarExpression({ mascotExpression: "happy" })).toBeUndefined();
  expect(avatarExpression({ mascotExpression: 7 })).toBe(7);
});
