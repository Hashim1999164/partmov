"use client";

/**
 * R2 film playback via same-origin progressive proxy.
 * Avoids browser→R2 CORS (bucket CORS is locked) and fragile MSE init.
 * The browser requests byte ranges through /api/r2/file.
 */

import { useMemo } from "react";
import type { RefObject } from "react";

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
  /** Progressive same-origin URL for <video src>. */
  fallbackSrc: string | null;
};

export function useWindowedR2Player({
  code,
  objectKey,
  enabled = true,
}: Options): WindowedR2State {
  const progressiveSrc = useMemo(() => {
    if (!enabled || !code || !objectKey) return null;
    const qs = new URLSearchParams({ code, objectKey });
    return `/api/r2/file?${qs.toString()}`;
  }, [code, enabled, objectKey]);

  return {
    ready: Boolean(progressiveSrc),
    active: false,
    error: null,
    fallbackSrc: progressiveSrc,
  };
}
