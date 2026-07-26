"use client";

/**
 * Windowed R2 MP4 player: keep ~2 minutes behind and ahead of the playhead in MSE,
 * fetching only those byte ranges from R2. Host seeks flush the old window immediately.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { createFile, type MP4File, type MP4Info } from "mp4box";

const WINDOW_BEHIND = 120;
const WINDOW_AHEAD = 120;
const CHUNK = 1024 * 1024; // 1 MiB range requests
const PREFETCH_EDGE = 35;
const SAMPLES_PER_SEGMENT = 30;

type Options = {
  videoRef: RefObject<HTMLVideoElement | null>;
  code: string;
  objectKey: string | null | undefined;
  enabled?: boolean;
};

export type WindowedR2State = {
  ready: boolean;
  active: boolean;
  error: string | null;
  /** Progressive signed-URL fallback when MSE/mp4box cannot handle the file. */
  fallbackSrc: string | null;
};

function covers(video: HTMLVideoElement, from: number, to: number) {
  const b = video.buffered;
  for (let i = 0; i < b.length; i++) {
    if (b.start(i) <= from + 0.5 && b.end(i) >= Math.min(to, from + 1) - 0.25) {
      // Prefer full coverage when possible
      if (b.end(i) >= to - 1) return true;
    }
  }
  // Partial ahead coverage still counts as usable if we have ≥15s ahead
  for (let i = 0; i < b.length; i++) {
    const playhead = video.currentTime;
    if (b.start(i) <= playhead + 0.35 && b.end(i) >= playhead + 15) return true;
  }
  return false;
}

function bufferedAhead(video: HTMLVideoElement) {
  const t = video.currentTime;
  const b = video.buffered;
  for (let i = 0; i < b.length; i++) {
    if (b.start(i) <= t + 0.5 && b.end(i) > t) return b.end(i) - t;
  }
  return 0;
}

async function fetchRange(
  code: string,
  objectKey: string,
  start: number,
  end: number,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const qs = new URLSearchParams({
    code,
    objectKey,
    start: String(start),
    end: String(end),
  });
  const res = await fetch(`/api/r2/bytes?${qs}`, { signal });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || `Range ${res.status}`);
  }
  return res.arrayBuffer();
}

async function fetchMeta(code: string, objectKey: string) {
  const qs = new URLSearchParams({ code, objectKey, meta: "1" });
  const res = await fetch(`/api/r2/bytes?${qs}`);
  if (!res.ok) throw new Error("Could not read cloud film metadata");
  return (await res.json()) as { size: number; contentType: string };
}

export function useWindowedR2Player({
  videoRef,
  code,
  objectKey,
  enabled = true,
}: Options): WindowedR2State {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fallbackSrc, setFallbackSrc] = useState<string | null>(null);
  const [active, setActive] = useState(false);

  const genRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const mp4Ref = useRef<MP4File | null>(null);
  const msRef = useRef<MediaSource | null>(null);
  const sbRef = useRef<SourceBuffer[]>([]);
  const appendQRef = useRef<ArrayBuffer[]>([]);
  const appendingRef = useRef(false);
  const objectUrlRef = useRef<string | null>(null);
  const fileSizeRef = useRef(0);
  const durationRef = useRef(0);
  const loadingRef = useRef(false);
  const lastSeekLoadRef = useRef(0);

  const pumpAppends = useCallback(async () => {
    if (appendingRef.current) return;
    appendingRef.current = true;
    try {
      while (appendQRef.current.length) {
        const sbs = sbRef.current.filter((sb) => sb && !sb.updating);
        if (!sbs.length) {
          await new Promise((r) => setTimeout(r, 16));
          continue;
        }
        const buf = appendQRef.current.shift();
        if (!buf) break;
        // Prefer video track buffer if multiple; otherwise first free.
        const sb = sbs[0];
        try {
          sb.appendBuffer(buf);
          await new Promise<void>((resolve, reject) => {
            const onEnd = () => {
              sb.removeEventListener("updateend", onEnd);
              sb.removeEventListener("error", onErr);
              resolve();
            };
            const onErr = () => {
              sb.removeEventListener("updateend", onEnd);
              sb.removeEventListener("error", onErr);
              reject(new Error("SourceBuffer append failed"));
            };
            sb.addEventListener("updateend", onEnd);
            sb.addEventListener("error", onErr);
          });
        } catch {
          /* ignore QuotaExceeded — window clear will recover */
          break;
        }
      }
    } finally {
      appendingRef.current = false;
    }
  }, []);

  const clearBuffers = useCallback(async () => {
    appendQRef.current = [];
    const sbs = [...sbRef.current];
    for (const sb of sbs) {
      if (!sb) continue;
      try {
        if (sb.updating) {
          sb.abort();
          await new Promise((r) => setTimeout(r, 20));
        }
        if (sb.buffered.length) {
          const start = sb.buffered.start(0);
          const end = sb.buffered.end(sb.buffered.length - 1);
          sb.remove(start, end);
          await new Promise<void>((resolve) => {
            const done = () => {
              sb.removeEventListener("updateend", done);
              resolve();
            };
            sb.addEventListener("updateend", done);
            // If remove was sync-noop
            window.setTimeout(done, 80);
          });
        }
      } catch {
        /* ignore */
      }
    }
  }, []);

  const loadWindow = useCallback(
    async (centerSec: number, mode: "hard" | "soft") => {
      const video = videoRef.current;
      const mp4 = mp4Ref.current;
      if (!video || !mp4 || !objectKey || !code) return;
      if (!fileSizeRef.current || !durationRef.current) return;

      const gen = ++genRef.current;
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;

      if (mode === "hard") {
        await clearBuffers();
      }

      const from =
        mode === "hard"
          ? Math.max(0, centerSec - WINDOW_BEHIND)
          : Math.max(0, centerSec - 2);
      const to = Math.min(durationRef.current, centerSec + WINDOW_AHEAD);
      const seekInfo = mp4.seek(from, true);
      let offset = Math.max(0, Math.floor(seekInfo.offset || 0));
      const bytesPerSec = fileSizeRef.current / Math.max(1, durationRef.current);
      const endByte = Math.min(
        fileSizeRef.current - 1,
        Math.ceil(to * bytesPerSec) + CHUNK * 2,
      );

      loadingRef.current = true;
      try {
        while (offset < endByte && gen === genRef.current && !ac.signal.aborted) {
          const end = Math.min(fileSizeRef.current - 1, offset + CHUNK - 1);
          const ab = await fetchRange(code, objectKey, offset, end, ac.signal);
          if (gen !== genRef.current) return;
          const buf = ab as ArrayBuffer & { fileStart: number };
          buf.fileStart = offset;
          const next = mp4.appendBuffer(buf);
          mp4.flush();
          offset = typeof next === "number" && next > offset ? next : end + 1;
          await pumpAppends();

          if (covers(video, Math.max(from, centerSec - 5), Math.min(to, centerSec + WINDOW_AHEAD))) {
            break;
          }
        }
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return;
        throw err;
      } finally {
        if (gen === genRef.current) loadingRef.current = false;
      }
    },
    [clearBuffers, code, objectKey, pumpAppends, videoRef],
  );

  const destroy = useCallback(() => {
    genRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    try {
      mp4Ref.current?.stop();
    } catch {
      /* ignore */
    }
    mp4Ref.current = null;
    sbRef.current = [];
    appendQRef.current = [];
    const ms = msRef.current;
    msRef.current = null;
    if (ms && ms.readyState === "open") {
      try {
        ms.endOfStream();
      } catch {
        /* ignore */
      }
    }
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    const video = videoRef.current;
    if (video && video.src.startsWith("blob:")) {
      video.removeAttribute("src");
      video.load();
    }
    setReady(false);
    setActive(false);
  }, [videoRef]);

  useEffect(() => {
    if (!enabled || !objectKey || !code) {
      destroy();
      setFallbackSrc(null);
      setError(null);
      return;
    }

    let cancelled = false;
    setError(null);
    setFallbackSrc(null);
    setReady(false);

    async function start() {
      const video = videoRef.current;
      if (!video) return;

      // MSE required for windowed buffering.
      if (typeof MediaSource === "undefined") {
        const { fetchR2PlaybackUrl } = await import("@/lib/r2-client");
        const signed = await fetchR2PlaybackUrl(code, objectKey!);
        if (!cancelled) {
          setFallbackSrc(signed.url);
          setActive(false);
          setReady(true);
        }
        return;
      }

      try {
        const meta = await fetchMeta(code, objectKey!);
        if (cancelled) return;
        fileSizeRef.current = meta.size;

        const mp4 = createFile(false);
        mp4Ref.current = mp4;

        const ms = new MediaSource();
        msRef.current = ms;
        const objUrl = URL.createObjectURL(ms);
        objectUrlRef.current = objUrl;
        video.src = objUrl;
        setActive(true);

        await new Promise<void>((resolve, reject) => {
          const onOpen = () => {
            ms.removeEventListener("sourceopen", onOpen);
            resolve();
          };
          ms.addEventListener("sourceopen", onOpen);
          ms.addEventListener("error", () => reject(new Error("MediaSource error")), { once: true });
        });
        if (cancelled) return;

        // Probe moov from the start of the file.
        let offset = 0;
        let readyInfo: MP4Info | null = null;
        mp4.onReady = (info) => {
          readyInfo = info;
        };
        mp4.onError = (msg) => {
          throw new Error(msg || "MP4 parse error");
        };

        while (!readyInfo && offset < meta.size) {
          const end = Math.min(meta.size - 1, offset + CHUNK - 1);
          const ab = await fetchRange(code, objectKey!, offset, end);
          if (cancelled) return;
          const buf = ab as ArrayBuffer & { fileStart: number };
          buf.fileStart = offset;
          const next = mp4.appendBuffer(buf);
          offset = typeof next === "number" && next > offset ? next : end + 1;
          if (readyInfo) break;
          if (offset > 48 * 1024 * 1024) {
            throw new Error("Could not find MP4 movie header (moov) near the start of the file");
          }
        }
        if (!readyInfo) throw new Error("MP4 header missing");
        const info: MP4Info = readyInfo;

        durationRef.current = info.duration / (info.timescale || 1);
        if (Number.isFinite(durationRef.current) && durationRef.current > 0) {
          try {
            ms.duration = durationRef.current;
          } catch {
            /* ignore */
          }
        }

        const tracks = info.tracks.filter((t) => t.type === "video" || t.type === "audio");
        if (!tracks.length) throw new Error("No playable tracks in film");

        mp4.onSegment = (_id, _user, buffer) => {
          appendQRef.current.push(buffer);
          void pumpAppends();
        };

        for (const t of tracks) {
          mp4.setSegmentOptions(t.id, null, { nbSamples: SAMPLES_PER_SEGMENT, rapAlignement: true });
        }
        const inits = mp4.initializeSegmentation();
        sbRef.current = [];

        // One SourceBuffer per codec family when possible; fall back to mime.
        const mime = info.mime || 'video/mp4; codecs="avc1.42E01E,mp4a.40.2"';
        if (!MediaSource.isTypeSupported(mime)) {
          throw new Error(`Browser cannot play ${mime}`);
        }
        const sb = ms.addSourceBuffer(mime);
        sbRef.current = [sb];
        for (const init of inits) {
          appendQRef.current.push(init.buffer);
        }
        await pumpAppends();
        mp4.start();

        await loadWindow(0, "hard");
        if (cancelled) return;
        setReady(true);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        console.warn("windowed R2 player failed, falling back", err);
        destroy();
        try {
          const { fetchR2PlaybackUrl } = await import("@/lib/r2-client");
          const signed = await fetchR2PlaybackUrl(code, objectKey!);
          setFallbackSrc(signed.url);
          setReady(true);
          setError(null);
        } catch (e2) {
          setError(e2 instanceof Error ? e2.message : "Could not stream from cloud");
        }
      }
    }

    void start();
    return () => {
      cancelled = true;
      destroy();
    };
  }, [code, destroy, enabled, loadWindow, objectKey, pumpAppends, videoRef]);

  // Instant window reload when host (or anyone) seeks.
  useEffect(() => {
    if (!active || !ready) return;
    const video = videoRef.current;
    if (!video) return;

    const onSeeking = () => {
      const t = video.currentTime;
      // Debounce tiny seeks from drift correction.
      if (Math.abs(t - lastSeekLoadRef.current) < 0.75 && loadingRef.current) return;
      lastSeekLoadRef.current = t;
      void loadWindow(t, "hard");
    };

    const onTimeUpdate = () => {
      if (loadingRef.current) return;
      const ahead = bufferedAhead(video);
      if (ahead < PREFETCH_EDGE) {
        void loadWindow(video.currentTime, "soft");
      }
    };

    video.addEventListener("seeking", onSeeking);
    video.addEventListener("timeupdate", onTimeUpdate);
    return () => {
      video.removeEventListener("seeking", onSeeking);
      video.removeEventListener("timeupdate", onTimeUpdate);
    };
  }, [active, loadWindow, ready, videoRef]);

  return { ready, active, error, fallbackSrc };
}
