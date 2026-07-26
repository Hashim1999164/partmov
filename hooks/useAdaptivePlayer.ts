"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import Hls, { type ErrorData, type LevelSwitchedData } from "hls.js";

export type QualityOption = {
  index: number;
  height: number;
  bitrate: number;
  label: string;
};

type Options = {
  videoRef: RefObject<HTMLVideoElement | null>;
  /** Master playlist URL (HLS). Empty disables. */
  src: string | null;
  /** Short-lived playback token appended / injected into requests */
  token: string | null;
  /** Called ~2 min before expiry so host can refresh */
  onTokenExpiring?: () => void | Promise<void>;
  tokenExpiresAt?: number | null;
  startLevel?: number;
  enabled?: boolean;
};

export type AdaptivePlayerState = {
  ready: boolean;
  levels: QualityOption[];
  currentLevel: number;
  autoLevel: boolean;
  error: string | null;
  droppedFrames: number;
  estimatedBandwidth: number;
  setQuality: (level: number | "auto") => void;
  setAudioTrack: (id: number) => void;
  setSubtitleTrack: (id: number | null) => void;
  audioTracks: Array<{ id: number; name: string; lang?: string }>;
  subtitleTracks: Array<{ id: number; name: string; lang?: string }>;
  destroy: () => void;
};

/**
 * hls.js adaptive player with ABR tuning, stall recovery, and token-aware loader.
 * Safari uses native HLS when hls.js is unsupported.
 */
export function useAdaptivePlayer({
  videoRef,
  src,
  token,
  onTokenExpiring,
  tokenExpiresAt,
  startLevel = 0,
  enabled = true,
}: Options): AdaptivePlayerState {
  const hlsRef = useRef<Hls | null>(null);
  const tokenRef = useRef(token);
  tokenRef.current = token;

  const [ready, setReady] = useState(false);
  const [levels, setLevels] = useState<QualityOption[]>([]);
  const [currentLevel, setCurrentLevel] = useState(-1);
  const [autoLevel, setAutoLevel] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [droppedFrames, setDroppedFrames] = useState(0);
  const [estimatedBandwidth, setEstimatedBandwidth] = useState(0);
  const [audioTracks, setAudioTracks] = useState<AdaptivePlayerState["audioTracks"]>([]);
  const [subtitleTracks, setSubtitleTracks] = useState<AdaptivePlayerState["subtitleTracks"]>([]);

  const destroy = useCallback(() => {
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    setReady(false);
  }, []);

  const setQuality = useCallback((level: number | "auto") => {
    const hls = hlsRef.current;
    if (!hls) return;
    if (level === "auto") {
      hls.currentLevel = -1;
      setAutoLevel(true);
    } else {
      hls.currentLevel = level;
      setAutoLevel(false);
    }
  }, []);

  const setAudioTrack = useCallback((id: number) => {
    if (hlsRef.current) hlsRef.current.audioTrack = id;
  }, []);

  const setSubtitleTrack = useCallback((id: number | null) => {
    if (hlsRef.current) hlsRef.current.subtitleTrack = id ?? -1;
  }, []);

  useEffect(() => {
    if (!tokenExpiresAt || !onTokenExpiring) return;
    const ms = tokenExpiresAt - Date.now() - 120_000;
    if (ms <= 0) {
      void onTokenExpiring();
      return;
    }
    const t = window.setTimeout(() => void onTokenExpiring(), ms);
    return () => window.clearTimeout(t);
  }, [tokenExpiresAt, onTokenExpiring]);

  useEffect(() => {
    if (!enabled || !src || !videoRef.current) {
      destroy();
      return;
    }
    const video = videoRef.current;
    setError(null);

    // Native HLS (Safari)
    if (!Hls.isSupported() && video.canPlayType("application/vnd.apple.mpegurl")) {
      const url = tokenRef.current ? appendToken(src, tokenRef.current) : src;
      video.src = url;
      setReady(true);
      setLevels([{ index: 0, height: 0, bitrate: 0, label: "Auto" }]);
      return () => {
        video.removeAttribute("src");
        video.load();
        setReady(false);
      };
    }

    if (!Hls.isSupported()) {
      setError("HLS not supported in this browser");
      return;
    }

    destroy();
    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      backBufferLength: 30,
      maxBufferLength: 30,
      maxMaxBufferLength: 60,
      startLevel,
      // Conservative start (~1 Mbps floor) then ABR up to 2 Mbps / 1080p.
      abrEwmaDefaultEstimate: 1_000_000,
      abrEwmaFastLive: 3,
      abrEwmaSlowLive: 9,
      abrBandWidthFactor: 0.8,
      abrBandWidthUpFactor: 0.6,
      maxStarvationDelay: 2,
      maxLoadingDelay: 2,
      manifestLoadingMaxRetry: 6,
      manifestLoadingRetryDelay: 500,
      levelLoadingMaxRetry: 6,
      fragLoadingMaxRetry: 6,
      xhrSetup: (xhr, url) => {
        xhr.withCredentials = true;
        // Token is carried via cookie and/or rewritten URL in pLoader below.
        void url;
      },
    });

    // Inject playback token into every playlist/segment URL (edge auth).
    const baseLoader = hls.config.loader;
    // Token injection for cross-origin edge requests (cookie + query fallback).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (hls.config as any).loader = class AuthedLoader extends (baseLoader as any) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      load(context: { url?: string }, config: unknown, callbacks: unknown) {
        const t = tokenRef.current;
        if (t && context?.url && !String(context.url).includes("token=")) {
          context.url = appendToken(String(context.url), t);
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        super.load(context, config, callbacks);
      }
    };

    hls.loadSource(src);
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      const opts = hls.levels.map((l, index) => ({
        index,
        height: l.height,
        bitrate: l.bitrate,
        label: l.height ? `${l.height}p` : `Level ${index}`,
      }));
      setLevels(opts);
      setReady(true);
      // Prefer lowest-safe start then ABR upswitches.
      if (hls.levels.length > 0) hls.startLevel = Math.min(startLevel, hls.levels.length - 1);
    });

    hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data: LevelSwitchedData) => {
      setCurrentLevel(data.level);
    });

    hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => {
      setAudioTracks(
        hls.audioTracks.map((t, id) => ({ id, name: t.name || `Audio ${id + 1}`, lang: t.lang })),
      );
    });
    hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => {
      setSubtitleTracks(
        hls.subtitleTracks.map((t, id) => ({ id, name: t.name || `CC ${id + 1}`, lang: t.lang })),
      );
    });

    hls.on(Hls.Events.ERROR, (_e, data: ErrorData) => {
      if (!data.fatal) {
        // Buffer-aware emergency: if starving, nudge down.
        if (data.details === "bufferStalledError" && hls.currentLevel > 0) {
          hls.nextLevel = Math.max(0, hls.currentLevel - 1);
        }
        return;
      }
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        hls.startLoad();
        return;
      }
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        hls.recoverMediaError();
        return;
      }
      setError(data.details || "fatal_hls_error");
      destroy();
    });

    const statsTimer = window.setInterval(() => {
      const q = video.getVideoPlaybackQuality?.();
      if (q) setDroppedFrames(q.droppedVideoFrames);
      setEstimatedBandwidth(hls.bandwidthEstimate || 0);
    }, 2000);

    hlsRef.current = hls;
    return () => {
      window.clearInterval(statsTimer);
      destroy();
    };
  }, [src, enabled, startLevel, videoRef, destroy]);

  // Hot-swap token without remounting.
  useEffect(() => {
    tokenRef.current = token;
  }, [token]);

  return {
    ready,
    levels,
    currentLevel,
    autoLevel,
    error,
    droppedFrames,
    estimatedBandwidth,
    setQuality,
    setAudioTrack,
    setSubtitleTrack,
    audioTracks,
    subtitleTracks,
    destroy,
  };
}

function appendToken(url: string, token: string) {
  const u = new URL(url, typeof window !== "undefined" ? window.location.href : "http://localhost");
  u.searchParams.set("token", token);
  return u.toString();
}
