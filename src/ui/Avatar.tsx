import { useEffect, useState } from "react";
import type { Bot } from "../core/contracts";
import type { MobileController } from "../core/controller";
import { CursorAvatar } from "../desktop/avatar/CursorAvatar";
import { CarvedAvatar } from "../desktop/avatar/CarvedAvatar";
import { MASCOT_BODIES, botMascotBody } from "../desktop/avatar/mascot-bodies";
import { CARVED_BODIES } from "../desktop/avatar/carved-bodies";
import { MAUS_COLORS, CHROME_GRADIENT, CHROME_EYES, type MausColor } from "../desktop/avatar/palette";
import { avatarCropRadius, botAvatarProfile, clampAvatarZoom, clampAvatarFocus, mascotFaceInk } from "../desktop/avatar/bot-avatar";

import steel from "../desktop/avatar/steel-images.json";
function mix(hex: string, toward: number, ratio: number): string {
  const value = parseInt(hex.slice(1), 16);
  return `#${[16, 8, 0].map(shift => Math.round(((value >> shift) & 255) * (1 - ratio) + toward * ratio).toString(16).padStart(2, "0")).join("")}`;
}
export function Avatar({ bot, controller, small = false, size: requestedSize }: { bot: Bot; controller: MobileController; small?: boolean; size?: number }) {
  const [image, setImage] = useState<{ path: string; url: string }>();
  const profile = botAvatarProfile(bot), path = profile.avatarCrop !== "mascot" ? profile.avatarUrl : undefined;
  useEffect(() => {
    if (!path) return;
    const abort = new AbortController(); let url: string | undefined;
    void controller.file(bot, null, path, abort.signal).then(file => {
      if (!abort.signal.aborted) { url = URL.createObjectURL(new Blob([new Uint8Array(file.data)], { type: file.mime })); setImage({ path: `${bot.workspace.id}/${path}`, url }); }
    }).catch(() => {});
    return () => { abort.abort(); if (url) URL.revokeObjectURL(url); };
  }, [controller, bot.workspace.id, path]);
  const size = requestedSize ?? (small ? 30 : 42);
  const color: MausColor = bot.color && Object.hasOwn(MAUS_COLORS, bot.color) ? bot.color as MausColor : "green";
  const fill = MAUS_COLORS[color];
  const gradient: [string, string, string] = color === "chrome" ? CHROME_GRADIENT : [mix(fill, 255, .55), fill, mix(fill, 0, .42)];
  const faceInk = mascotFaceInk(bot.mascotFaceColor), body = botMascotBody(bot.mascotBody);
  const origin = `${clampAvatarFocus(bot.avatarFocusX) * 100}% ${clampAvatarFocus(bot.avatarFocusY) * 100}%`;
  const picture = steel.includes(`${body}-128.webp`) ? `/mascot-steel/${body}-128.webp` : null;
  return <span className={`avatar ${small ? "small" : ""}`} style={{ width: size, height: size }} aria-hidden="true">
    {path && image?.path === `${bot.workspace.id}/${path}` ? <span className="avatar-crop" style={{ borderRadius: avatarCropRadius(profile.avatarCrop) }}><img src={image.url} alt="" onError={() => setImage(undefined)} style={{ objectPosition: origin, transform: `scale(${clampAvatarZoom(bot.avatarZoom)})`, transformOrigin: origin }} /></span>
      : bot.mascotBody && Object.hasOwn(CARVED_BODIES, bot.mascotBody) ? <CarvedAvatar body={bot.mascotBody as keyof typeof CARVED_BODIES} color={color} size={size} state={bot.busy ? "working" : "idle"} faceColor={bot.mascotFaceColor} trackPointer={false} />
        : <CursorAvatar size={size} state={bot.busy ? "working" : "idle"} expression={bot.mascotExpression ?? undefined} silhouette={MASCOT_BODIES[body]} gradient={gradient} picture={color === "chrome" && !faceInk ? picture : null} eyeColor={faceInk ?? (color === "chrome" ? CHROME_EYES : undefined)} eyeScale={1.12} showMouth mouthStroke={11} title={null} />}
  </span>;
}
