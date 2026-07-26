"use client";

import { useEffect, useRef, useState } from "react";

const WINDOW_MS = 24_000;
const TICK_MS = 100;
const LOCK_MS = 40;
const NUDGE_MAX = 0.05;
const STALL_EVERY_MS = 18_000;
const STALL_LENGTH_MS = 420;

type Frame = {
  hostMs: number;
  guestMs: number;
  rate: number;
  stalled: boolean;
};

/**
 * Illustrates the steady-state correction loop: the guest falls behind after a
 * short stall, then closes the gap with a sub-perceptual rate nudge instead of a seek.
 */
export function SyncVisual() {
  const [frame, setFrame] = useState<Frame>({ hostMs: 0, guestMs: -380, rate: 1, stalled: false });
  const state = useRef({ host: 0, guest: -380, sinceStall: 0, stallLeft: 0 });

  useEffect(() => {
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;

    const id = window.setInterval(() => {
      const s = state.current;
      s.host += TICK_MS;
      s.sinceStall += TICK_MS;

      if (s.stallLeft <= 0 && s.sinceStall >= STALL_EVERY_MS) {
        s.stallLeft = STALL_LENGTH_MS;
        s.sinceStall = 0;
      }

      const drift = s.guest - s.host;
      let rate = 1;

      if (s.stallLeft > 0) {
        s.stallLeft -= TICK_MS;
      } else if (Math.abs(drift) > LOCK_MS) {
        const nudge = Math.min(NUDGE_MAX, Math.abs(drift) / 4_000);
        rate = drift < 0 ? 1 + nudge : 1 - nudge;
        s.guest += TICK_MS * rate;
      } else {
        s.guest += TICK_MS;
      }

      setFrame({
        hostMs: s.host,
        guestMs: s.guest,
        rate,
        stalled: s.stallLeft > 0,
      });
    }, TICK_MS);

    return () => window.clearInterval(id);
  }, []);

  const drift = Math.round(frame.guestMs - frame.hostMs);
  const correcting = frame.stalled || Math.abs(drift) > LOCK_MS;
  const pct = (ms: number) => `${(((ms % WINDOW_MS) + WINDOW_MS) % WINDOW_MS / WINDOW_MS) * 100}%`;

  return (
    <div className="syncviz" role="img" aria-label="Simulation of host and guest playback heads staying in sync">
      <div className="syncviz__row">
        <span className="syncviz__label">host</span>
        <div className="syncviz__lane">
          <span className="syncviz__head" style={{ left: pct(frame.hostMs) }} />
        </div>
        <span className="syncviz__val">1.000&times;</span>
      </div>
      <div className="syncviz__row">
        <span className="syncviz__label">guest</span>
        <div className="syncviz__lane">
          <span className="syncviz__head syncviz__head--guest" style={{ left: pct(frame.guestMs) }} />
        </div>
        <span className="syncviz__val">{frame.rate.toFixed(3)}&times;</span>
      </div>
      <div className="syncviz__foot">
        <span>
          drift{" "}
          <span className={correcting ? "syncviz__state--correcting" : "syncviz__state"}>
            {drift > 0 ? "+" : ""}
            {drift} ms
          </span>
        </span>
        <span>
          state{" "}
          <span className={correcting ? "syncviz__state--correcting" : "syncviz__state"}>
            {frame.stalled ? "guest rebuffering" : correcting ? "rate nudge" : "locked"}
          </span>
        </span>
        <span>heartbeat 1 s &middot; hard seek threshold 1500 ms</span>
      </div>
    </div>
  );
}
