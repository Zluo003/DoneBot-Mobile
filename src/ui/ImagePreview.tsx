import { useEffect, useRef, useState, type PointerEvent } from "react";
import { clampImage, fitImage, originalImage, swipeDirection, zoomImage, type ImageTransform, type Point, type Size } from "./gestures";

export function ImagePreview({ src, alt, close }: { src: string; alt: string; close(): void }) {
  const container = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<Size>({ width: 0, height: 0 });
  const [natural, setNatural] = useState<Size>({ width: 0, height: 0 });
  const [transform, setTransform] = useState(originalImage);
  const current = useRef(transform);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<{ origin: Point; transform: ImageTransform; distance: number } | undefined>(undefined);
  const interaction = useRef<{ start: Point; time: number; multi: boolean; moved: boolean } | undefined>(undefined);
  const lastTap = useRef<{ point: Point; time: number } | undefined>(undefined);
  const suppressClick = useRef(false);
  const blankTap = useRef(false);
  const image = fitImage(natural, viewport);
  const update = (next: ImageTransform) => { current.current = clampImage(next, image, viewport); setTransform(current.current); };
  const local = (point: Point): Point => {
    const rect = container.current!.getBoundingClientRect();
    return { x: point.x - rect.left - rect.width / 2, y: point.y - rect.top - rect.height / 2 };
  };
  const anchor = () => {
    const points = [...pointers.current.values()];
    if (points.length >= 2) {
      const [a, b] = points as [Point, Point, ...Point[]];
      gesture.current = { origin: local({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }), distance: Math.hypot(a.x - b.x, a.y - b.y), transform: current.current };
    } else if (points[0]) gesture.current = { origin: points[0], distance: 0, transform: current.current };
    else gesture.current = undefined;
  };
  useEffect(() => {
    const element = container.current!;
    const observer = new ResizeObserver(() => {
      setViewport({ width: element.clientWidth, height: element.clientHeight });
      current.current = originalImage; setTransform(originalImage);
      pointers.current.clear(); gesture.current = undefined; interaction.current = undefined;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const point = { x: event.clientX, y: event.clientY };
    if (!pointers.current.size) { interaction.current = { start: point, time: performance.now(), multi: false, moved: false }; suppressClick.current = false; blankTap.current = event.target === event.currentTarget; }
    pointers.current.set(event.pointerId, point);
    if (pointers.current.size > 1) { interaction.current!.multi = true; suppressClick.current = true; lastTap.current = undefined; }
    event.currentTarget.setPointerCapture(event.pointerId);
    anchor();
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId) || !gesture.current || !interaction.current) return;
    const point = { x: event.clientX, y: event.clientY };
    pointers.current.set(event.pointerId, point);
    if (Math.hypot(point.x - interaction.current.start.x, point.y - interaction.current.start.y) > 8) { interaction.current.moved = true; suppressClick.current = true; }
    const points = [...pointers.current.values()], base = gesture.current;
    if (points.length >= 2) {
      const [a, b] = points as [Point, Point, ...Point[]];
      if (base.distance > 0) update(zoomImage(base.transform, base.transform.scale * Math.hypot(a.x - b.x, a.y - b.y) / base.distance, base.origin, local({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })));
    } else if (current.current.scale > 1) update({ ...base.transform, x: base.transform.x + point.x - base.origin.x, y: base.transform.y + point.y - base.origin.y });
  };
  const up = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.delete(event.pointerId);
    if (pointers.current.size) { anchor(); return; }
    const action = interaction.current;
    gesture.current = undefined; interaction.current = undefined;
    if (!action || action.multi) return;
    const point = { x: event.clientX, y: event.clientY }, time = performance.now();
    if (action.moved) {
      lastTap.current = undefined;
      if (current.current.scale === 1 && swipeDirection(action.start, point, time - action.time)) close();
    } else if (!blankTap.current) {
      const previous = lastTap.current;
      if (previous && time - previous.time < 320 && Math.hypot(point.x - previous.point.x, point.y - previous.point.y) < 32) {
        update(current.current.scale > 1 ? originalImage : zoomImage(current.current, 2.5, local(point)));
        lastTap.current = undefined; suppressClick.current = true;
      } else lastTap.current = { point, time };
    } else lastTap.current = undefined;
  };
  const cancel = () => { pointers.current.clear(); gesture.current = undefined; interaction.current = undefined; lastTap.current = undefined; suppressClick.current = true; };
  return <div ref={container} className="zoomable-image" data-swipe-ignore role="group" aria-label="图片预览，可双指或双击缩放" tabIndex={0}
    onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel} onLostPointerCapture={event => { if (pointers.current.has(event.pointerId)) cancel(); }}
    onClick={event => { event.stopPropagation(); if (!suppressClick.current && blankTap.current) close(); }}
    onKeyDown={event => {
      if (["+", "=", "-", "0"].includes(event.key)) {
        event.preventDefault();
        update(event.key === "0" ? originalImage : zoomImage(current.current, current.current.scale * (event.key === "-" ? 1 / 1.5 : 1.5), { x: 0, y: 0 }));
      }
    }}>
    <img src={src} alt={alt} draggable={false} onLoad={event => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} style={{ width: image.width || undefined, height: image.height || undefined, transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})` }} />
  </div>;
}
