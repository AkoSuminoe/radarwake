// Calm readings: the same smoothing the OLED firmware uses (firmware/src/display.cpp),
// so the number on the phone and on the desk agree and only change on a real move.

import { useEffect, useRef, useState } from "react";
import type { LiveReading } from "./api";

export interface CalmReading {
  present: boolean;
  distCm: number | null; // 0.1 m steps
  moving: boolean;
  signal: number | null; // 0-100, smoothed
}

const ALPHA = 0.35; // per 1 s poll
const MIN_STEP_CM = 8;
const MOTION_HOLD_MS = 2000;
const ABSENT_HOLD_MS = 3000;

export function targetDistance(l: LiveReading): number {
  return l.stationary && l.stationary_dist > 0 ? l.stationary_dist : l.moving_dist;
}

export function useCalmReading(live: LiveReading | null, fresh: boolean): CalmReading {
  const s = useRef({ ema: 0, shown: 0, sig: 0, present: false, absentSince: 0, moving: false, rawMoving: false, movingSince: 0, ts: "" });
  const [out, setOut] = useState<CalmReading>({ present: false, distCm: null, moving: false, signal: null });

  useEffect(() => {
    const st = s.current;
    const now = Date.now();
    const raw = !!live && fresh && live.presence;
    if (live && live.ts === st.ts && raw === st.present) return;
    st.ts = live?.ts ?? "";

    if (raw) {
      st.present = true;
      st.absentSince = 0;
    } else if (st.present) {
      st.absentSince ||= now;
      if (now - st.absentSince > ABSENT_HOLD_MS) st.present = false;
    }

    if (raw && live) {
      const d = targetDistance(live);
      if (d > 0) st.ema = st.ema <= 0 ? d : st.ema + ALPHA * (d - st.ema);
      const e = Math.max(live.moving ? live.moving_energy : 0, live.stationary ? live.stationary_energy : 0);
      st.sig = st.sig <= 0 ? e : st.sig + 0.2 * (e - st.sig);
      if (live.moving !== st.rawMoving) {
        st.rawMoving = live.moving;
        st.movingSince = now;
      }
      if (live.moving !== st.moving && now - st.movingSince >= MOTION_HOLD_MS) st.moving = live.moving;
    }
    if (!st.present) {
      st.ema = 0;
      st.sig = 0;
      st.shown = 0;
    } else if (st.ema > 0 && (st.shown === 0 || Math.abs(st.ema - st.shown) >= MIN_STEP_CM)) {
      st.shown = Math.round(st.ema / 10) * 10;
    }

    setOut((prev) => {
      const next: CalmReading = {
        present: st.present,
        distCm: st.present && st.shown > 0 ? st.shown : null,
        moving: st.moving,
        signal: st.present ? Math.round(st.sig / 5) * 5 : null,
      };
      return prev.present === next.present && prev.distCm === next.distCm && prev.moving === next.moving && prev.signal === next.signal
        ? prev
        : next;
    });
  }, [live, fresh]);

  return out;
}
