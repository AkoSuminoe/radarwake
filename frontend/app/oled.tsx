"use client";

// 128x64 OLED preview. GIF frames come from the server in the same 1-bit format the ESP32
// receives, so the preview shows exactly what the panel will draw. Text layouts are an
// approximation of firmware/src/display.cpp drawn with the dashboard's mono font.

import { useEffect, useRef, useState } from "react";
import { Animation, Layout, ProfileOptions, api } from "@/lib/api";

export const W = 128;
export const H = 64;
const LIT = "#dbe9ff";

export interface Sample {
  present: boolean;
  distCm: number | null;
  moving: boolean;
  pc: string;
}

interface Frames {
  w: number;
  h: number;
  dur: number[];
  images: HTMLCanvasElement[];
}

const cache = new Map<string, Promise<Frames>>();

export function boxFor(layout: Layout): "full" | "square" {
  return layout === "gif_status" ? "square" : "full";
}

export function isGifLayout(layout: Layout): boolean {
  return layout === "gif" || layout === "gif_status" || layout === "gif_corner";
}

function decode(buf: ArrayBuffer): Frames {
  const view = new DataView(buf);
  const jlen = view.getUint16(0, true);
  const cfg = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 2, jlen)));
  const a = cfg.anim as { w: number; h: number; n: number; dur: number[] } | null;
  if (!a) return { w: 0, h: 0, dur: [], images: [] };
  const stride = Math.ceil(a.w / 8);
  const bytes = new Uint8Array(buf, 2 + jlen);
  const images: HTMLCanvasElement[] = [];
  for (let f = 0; f < a.n; f++) {
    const c = document.createElement("canvas");
    c.width = a.w;
    c.height = a.h;
    const ctx = c.getContext("2d")!;
    const img = ctx.createImageData(a.w, a.h);
    const base = f * stride * a.h;
    for (let y = 0; y < a.h; y++) {
      for (let x = 0; x < a.w; x++) {
        if (bytes[base + y * stride + (x >> 3)] & (1 << (x & 7))) {
          const i = (y * a.w + x) * 4;
          img.data[i] = 0xdb;
          img.data[i + 1] = 0xe9;
          img.data[i + 2] = 0xff;
          img.data[i + 3] = 255;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    images.push(c);
  }
  return { w: a.w, h: a.h, dur: a.dur, images };
}

export function loadFrames(anim: Animation, box: "full" | "square"): Promise<Frames> {
  const key = `${anim.id}:${anim.updated_at}:${box}`;
  let p = cache.get(key);
  if (!p) {
    p = api.animationFrames(anim.id, box).then(decode);
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return p;
}

function monoFamily(): string {
  if (typeof document === "undefined") return "monospace";
  return getComputedStyle(document.body).getPropertyValue("--font-mono").trim() || "monospace";
}

const PC_LABEL: Record<string, string> = { on: "PC ON", off: "PC OFF", waking: "BOOT" };

export function OledPreview({
  layout,
  options,
  anim,
  sample,
  label,
}: {
  layout: Layout;
  options: ProfileOptions;
  anim: Animation | null;
  sample: Sample;
  label?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [frames, setFrames] = useState<Frames | null>(null);
  const live = useRef({ layout, options, sample });
  live.current = { layout, options, sample };

  useEffect(() => {
    setFrames(null);
    if (!anim || !isGifLayout(layout)) return;
    let alive = true;
    loadFrames(anim, boxFor(layout)).then((f) => alive && setFrames(f)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [anim, layout]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const font = monoFamily();
    let frame = 0;
    let frameAt = performance.now();
    let raf = 0;
    let last = 0;

    const text = (s: string, x: number, y: number, size: number, align: CanvasTextAlign = "left", weight = 500) => {
      ctx.font = `${weight} ${size}px ${font}`;
      ctx.textAlign = align;
      ctx.fillText(s, x, y);
    };

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      const { layout, options, sample } = live.current;
      const gif = isGifLayout(layout);
      if (gif && frames && frames.images.length) {
        if (now - frameAt >= (frames.dur[frame] ?? 100)) {
          frameAt = now;
          frame = (frame + 1) % frames.images.length;
        } else if (now - last < 200) return;
      } else if (now - last < 200) return;
      last = now;

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, H);
      if (options.flip) ctx.setTransform(-1, 0, 0, -1, W, H);
      ctx.globalAlpha = 0.45 + (0.55 * options.contrast) / 255;
      ctx.fillStyle = LIT;
      ctx.strokeStyle = LIT;
      ctx.lineWidth = 1;
      ctx.textBaseline = "alphabetic";

      const dist = sample.present && sample.distCm ? (sample.distCm / 100).toFixed(1) : null;
      const pc = PC_LABEL[sample.pc] ?? "PC ?";

      const top = () => {
        text(sample.present ? "PRESENT" : "CLEAR", 0, 7, 7);
        if (options.show_pc) text(pc, 112, 7, 7, "right");
        for (let i = 0; i < 4; i++) ctx.fillRect(116 + i * 3, 8 - (2 + i * 2), 2, 2 + i * 2);
      };

      const sector = (ox: number, oy: number, r: number) => {
        const a0 = (-60 - 90) * (Math.PI / 180);
        const a1 = (60 - 90) * (Math.PI / 180);
        ctx.beginPath();
        ctx.moveTo(ox, oy);
        ctx.arc(ox, oy, r, a0, a1);
        ctx.closePath();
        ctx.stroke();
        if (dist) {
          ctx.beginPath();
          ctx.lineWidth = 2;
          ctx.arc(ox, oy, (Math.min(sample.distCm!, 400) / 400) * r, a0, a1);
          ctx.stroke();
          ctx.lineWidth = 1;
        }
      };

      if (layout === "status") {
        top();
        ctx.fillRect(0, 11, W, 1);
        if (dist) {
          ctx.font = `600 30px ${font}`;
          const w = ctx.measureText(dist).width;
          const x = Math.round((W - w - 10) / 2);
          text(dist, x, 50, 30, "left", 600);
          text("m", x + w + 3, 50, 10, "left");
          text(sample.moving ? "moving" : "still", 64, 62, 7, "center");
        } else text("no one in range", 64, 41, 9, "center");
      } else if (layout === "sonar") {
        top();
        sector(34.5, 63.5, 44);
        if (dist) {
          text(dist, 84, 42, 20, "left", 600);
          text(sample.moving ? "moving" : "still", 84, 54, 7);
        } else text("clear", 84, 38, 7);
      } else if (layout === "clock") {
        const d = new Date();
        const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
        text(hm, 64, 44, 32, "center", 600);
        text(d.toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short" }).replace(",", ""), 64, 60, 9, "center");
        ctx.beginPath();
        ctx.arc(122, 4, 2, 0, Math.PI * 2);
        if (sample.present) ctx.fill();
        else ctx.stroke();
      } else {
        const img = frames?.images[frame];
        if (!img) {
          text(animLabel(frames), 64, 34, 9, "center");
        } else {
          ctx.drawImage(img, 0, 0);
          if (layout === "gif_status") {
            if (options.show_pc) text(pc, 70, 8, 7);
            if (dist) {
              text(dist, 70, 42, 20, "left", 600);
              text(sample.moving ? "moving" : "still", 70, 56, 7);
            } else text("clear", 70, 36, 7);
          } else if (layout === "gif_corner") {
            const s = dist ? `${dist}m` : "--";
            ctx.font = `500 9px ${font}`;
            const w = Math.ceil(ctx.measureText(s).width) + 5;
            const x = options.corner[1] === "l" ? 0 : W - w;
            const y = options.corner[0] === "t" ? 0 : H - 11;
            ctx.save();
            ctx.globalAlpha = 1;
            ctx.fillStyle = "#000";
            ctx.fillRect(x, y, w, 11);
            ctx.restore();
            ctx.strokeRect(x + 0.5, y + 0.5, w - 1, 10);
            text(s, x + 2.5, y + 8.5, 9);
          }
        }
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [frames]);

  return (
    <div className="oled">
      <canvas ref={ref} width={W} height={H} aria-label={label ?? "OLED preview"} />
    </div>
  );

  function animLabel(f: Frames | null): string {
    if (!anim) return "NO GIF";
    return f ? "NO GIF" : "loading…";
  }
}
