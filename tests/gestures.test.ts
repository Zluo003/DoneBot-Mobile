import { describe, expect, it } from "vitest";
import { clampImage, fitImage, originalImage, swipeDirection, zoomImage } from "../src/ui/gestures";

describe("navigation gestures", () => {
  it("recognizes deliberate left and downward swipes while rejecting taps, vertical scrolling, diagonals and long presses", () => {
    const start = { x: 200, y: 200 };
    expect(swipeDirection(start, { x: 90, y: 210 }, 400)).toBe("left");
    expect(swipeDirection(start, { x: 210, y: 310 }, 400)).toBe("down");
    for (const end of [{ x: 198, y: 204 }, { x: 210, y: 90 }, { x: 90, y: 310 }, { x: 300, y: 200 }]) expect(swipeDirection(start, end, 400)).toBeUndefined();
    expect(swipeDirection(start, { x: 90, y: 200 }, 1200)).toBeUndefined();
  });
});

describe("image preview geometry", () => {
  const viewport = { width: 390, height: 700 }, image = { width: 390, height: 219.375 };
  it("fits landscape, portrait and small images without stretching or enlarging them", () => {
    expect(fitImage({ width: 480, height: 270 }, viewport)).toEqual(image);
    expect(fitImage({ width: 1000, height: 2000 }, viewport)).toEqual({ width: 350, height: 700 });
    expect(fitImage({ width: 80, height: 60 }, viewport)).toEqual({ width: 80, height: 60 });
  });
  it("keeps the same image point beneath moving pinch fingers", () => {
    const before = { scale: 1.5, x: 30, y: -20 }, anchor = { x: 40, y: 10 }, center = { x: 60, y: 30 };
    const after = zoomImage(before, 3, anchor, center);
    expect((center.x - after.x) / after.scale).toBeCloseTo((anchor.x - before.x) / before.scale);
    expect((center.y - after.y) / after.scale).toBeCloseTo((anchor.y - before.y) / before.scale);
  });
  it("bounds zoom and pan and recenters when pinched back to the original size", () => {
    expect(clampImage({ scale: 9, x: 10000, y: -10000 }, image, viewport)).toEqual({ scale: 4, x: 585, y: -88.75 });
    expect(clampImage({ scale: .5, x: 300, y: -300 }, image, viewport)).toEqual(originalImage);
    expect(clampImage({ scale: 2, x: 50, y: 100 }, image, viewport)).toEqual({ scale: 2, x: 50, y: 0 });
  });
  it("clamps pinch scale before computing its focal position", () => {
    expect(zoomImage(originalImage, 10, { x: 20, y: 10 })).toEqual(zoomImage(originalImage, 4, { x: 20, y: 10 }));
    expect(zoomImage(originalImage, .1, { x: 20, y: 10 })).toEqual(originalImage);
  });
});
