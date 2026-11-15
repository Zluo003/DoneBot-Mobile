import { useEffect, useRef, type RefObject } from "react";

export type Point = { x: number; y: number };
export type Size = { width: number; height: number };
export type ImageTransform = Point & { scale: number };
export const originalImage: ImageTransform = { x: 0, y: 0, scale: 1 };

export function swipeDirection(start: Point, end: Point, elapsed: number): "left" | "right" | "down" | undefined {
  if (elapsed > 1000) return;
  const x = end.x - start.x, y = end.y - start.y;
  if (x <= -72 && -x > Math.abs(y) * 1.5) return "left";
  if (start.x <= 28 && x >= 72 && x > Math.abs(y) * 1.5) return "right";
  if (y >= 80 && y > Math.abs(x) * 1.5) return "down";
}

export function fitImage(image: Size, viewport: Size): Size {
  if (!image.width || !image.height) return { width: 0, height: 0 };
  const scale = Math.min(1, viewport.width / image.width, viewport.height / image.height);
  return { width: image.width * scale, height: image.height * scale };
}

export function clampImage(transform: ImageTransform, image: Size, viewport: Size): ImageTransform {
  const scale = Math.min(4, Math.max(1, transform.scale));
  const x = Math.max(0, (image.width * scale - viewport.width) / 2);
  const y = Math.max(0, (image.height * scale - viewport.height) / 2);
  return { scale, x: x ? Math.max(-x, Math.min(x, transform.x)) : 0, y: y ? Math.max(-y, Math.min(y, transform.y)) : 0 };
}

export function zoomImage(transform: ImageTransform, scale: number, anchor: Point, center: Point = anchor): ImageTransform {
  const next = Math.min(4, Math.max(1, scale));
  return { scale: next, x: center.x - (anchor.x - transform.x) * next / transform.scale, y: center.y - (anchor.y - transform.y) * next / transform.scale };
}

export function useSwipeNavigation(ref: RefObject<HTMLElement | null>, back: () => void, options: { enabled?: boolean; down?: boolean } = {}) {
  const callback = useRef(back);
  callback.current = back;
  const { enabled = true, down = false } = options;
  useEffect(() => {
    const element = ref.current;
    if (!enabled || !element) return;
    let gesture: { id: number; start: Point; time: number; down: boolean; vertical: boolean } | undefined;
    const cancel = () => { gesture = undefined; };
    const start = (event: TouchEvent) => {
      cancel();
      if (event.touches.length !== 1 || (window.visualViewport?.scale ?? 1) > 1.01) return;
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      if (target.closest("input, textarea, select, audio, iframe, [role=slider], [data-swipe-ignore]")) return;
      const modal = target.closest("dialog");
      if (modal && modal !== element) return;
      const touch = event.touches[0]!;
      const video = target.closest("video");
      if (video && touch.clientY > video.getBoundingClientRect().bottom - 64) return;
      if (window.getSelection()?.toString()) return;
      let allowDown = down;
      for (let node: Element | null = target; node && node !== element; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (node.scrollWidth > node.clientWidth + 2 && /auto|scroll/.test(style.overflowX)) return;
        if (node.scrollTop > 0) allowDown = false;
      }
      gesture = { id: touch.identifier, start: { x: touch.clientX, y: touch.clientY }, time: performance.now(), down: allowDown, vertical: false };
    };
    const move = (event: TouchEvent) => {
      if (!gesture) return;
      if (event.touches.length !== 1) return cancel();
      const touch = event.touches[0]!;
      if (touch.identifier !== gesture.id) return cancel();
      const x = touch.clientX - gesture.start.x, y = touch.clientY - gesture.start.y;
      if (Math.abs(y) > 12 && Math.abs(y) > Math.abs(x) * 1.5) gesture.vertical = true;
      if ((!gesture.vertical && ((x < -12 && -x > Math.abs(y) * 1.5) || (gesture.start.x <= 28 && x > 12 && x > Math.abs(y) * 1.5))) || (gesture.down && y > 12 && y > Math.abs(x) * 1.5)) {
        if (event.cancelable) event.preventDefault();
      }
    };
    const end = (event: TouchEvent) => {
      const current = gesture;
      cancel();
      if (!current || event.touches.length) return;
      const touch = Array.from(event.changedTouches).find(touch => touch.identifier === current.id);
      if (!touch) return;
      const direction = swipeDirection(current.start, { x: touch.clientX, y: touch.clientY }, performance.now() - current.time);
      if (((direction === "left" || direction === "right") && !current.vertical) || (direction === "down" && current.down)) {
        if (event.cancelable) event.preventDefault();
        callback.current();
      }
    };
    element.addEventListener("touchstart", start, { passive: true });
    element.addEventListener("touchmove", move, { passive: false });
    element.addEventListener("touchend", end, { passive: false });
    element.addEventListener("touchcancel", cancel);
    return () => {
      element.removeEventListener("touchstart", start);
      element.removeEventListener("touchmove", move);
      element.removeEventListener("touchend", end);
      element.removeEventListener("touchcancel", cancel);
    };
  }, [ref, enabled, down]);
}
