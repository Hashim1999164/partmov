"use client";

/**
 * In-tab background R2 upload jobs.
 * Survives lobby → room client navigation (module singleton).
 * Reloads abort the upload — guarded by beforeunload.
 */

import { useEffect, useSyncExternalStore } from "react";
import {
  uploadFileToR2,
  type R2UploadProgress,
  type R2UploadResult,
} from "@/lib/r2-client";

export type R2UploadJobStatus = "queued" | "uploading" | "finalizing" | "done" | "error";

export type R2UploadJob = {
  code: string;
  fileName: string;
  title: string;
  status: R2UploadJobStatus;
  pct: number;
  bytesLoaded: number;
  bytesTotal: number;
  phase: R2UploadProgress["phase"];
  startedAt: number;
  result?: R2UploadResult;
  error?: string;
};

type InternalJob = {
  file: File;
  subtitle?: File;
  listeners: Set<() => void>;
  /** Stable public snapshot — only replaced on emit (required by useSyncExternalStore). */
  pub: R2UploadJob;
};

const jobs = new Map<string, InternalJob>();
const globalListeners = new Set<() => void>();
/** Stable null for hooks when nothing is active. */
let activePub: R2UploadJob | null = null;
let unloadArmed = false;

function makePub(partial: R2UploadJob): R2UploadJob {
  return { ...partial };
}

function refreshActivePub() {
  for (const j of jobs.values()) {
    if (
      j.pub.status === "uploading" ||
      j.pub.status === "queued" ||
      j.pub.status === "finalizing"
    ) {
      activePub = j.pub;
      return;
    }
  }
  activePub = null;
}

function emit(job?: InternalJob) {
  if (job) {
    job.pub = makePub(job.pub);
    for (const fn of job.listeners) fn();
  }
  refreshActivePub();
  for (const fn of globalListeners) fn();
}

function armUnloadGuard() {
  if (unloadArmed || typeof window === "undefined") return;
  unloadArmed = true;
  window.addEventListener("beforeunload", onBeforeUnload);
}

function onBeforeUnload(e: BeforeUnloadEvent) {
  if (
    ![...jobs.values()].some(
      (j) =>
        j.pub.status === "uploading" ||
        j.pub.status === "queued" ||
        j.pub.status === "finalizing",
    )
  ) {
    return;
  }
  e.preventDefault();
  e.returnValue = "";
}

export function hasActiveR2Upload(code?: string) {
  for (const j of jobs.values()) {
    if (code && j.pub.code !== code) continue;
    if (
      j.pub.status === "uploading" ||
      j.pub.status === "queued" ||
      j.pub.status === "finalizing"
    ) {
      return true;
    }
  }
  return false;
}

export function getR2UploadJob(code: string): R2UploadJob | null {
  return jobs.get(code)?.pub ?? null;
}

export function getR2UploadSubtitle(code: string): File | undefined {
  return jobs.get(code)?.subtitle;
}

export function clearR2UploadJob(code: string) {
  jobs.delete(code);
  emit();
}

/** React hook — re-renders on progress for a room code. */
export function useR2UploadJob(code: string): R2UploadJob | null {
  return useSyncExternalStore(
    (onChange) => {
      globalListeners.add(onChange);
      jobs.get(code)?.listeners.add(onChange);
      return () => {
        globalListeners.delete(onChange);
        jobs.get(code)?.listeners.delete(onChange);
      };
    },
    () => getR2UploadJob(code),
    () => null,
  );
}

/** Any in-flight upload in this tab (lobby / other routes). */
export function useActiveR2UploadJob(): R2UploadJob | null {
  return useSyncExternalStore(
    (onChange) => {
      globalListeners.add(onChange);
      return () => globalListeners.delete(onChange);
    },
    () => activePub,
    () => null,
  );
}

export function jobToTransferProgress(job: R2UploadJob | null): TransferProgressLike | null {
  if (!job) return null;
  if (job.status === "done" || job.status === "error") return null;
  return {
    transferId: `r2-job-${job.code}`,
    fileName: job.fileName,
    kind: "video" as const,
    pct: job.pct,
    direction: "send" as const,
    phase: (job.status === "finalizing" || job.phase === "finalizing"
      ? "finalizing"
      : "sending") as "sending" | "finalizing",
    bytesLoaded: job.bytesLoaded,
    bytesTotal: job.bytesTotal,
    startedAt: job.startedAt,
    via: "r2" as const,
  };
}

/** Minimal shape shared with TransferDock / TransferProgress. */
export type TransferProgressLike = {
  transferId: string;
  fileName: string;
  kind: "video" | "subtitle";
  pct: number;
  direction: "send" | "receive";
  phase: "reading" | "sending" | "waiting_peer" | "receiving" | "finalizing" | "streaming";
  bytesLoaded?: number;
  bytesTotal?: number;
  startedAt?: number;
  via?: "r2" | "peer";
};

/**
 * Start (or keep) a background upload for a room. Returns immediately.
 * Call from lobby before navigating into the room.
 */
export function startR2UploadJob(opts: {
  code: string;
  file: File;
  title?: string;
  subtitle?: File;
}): R2UploadJob {
  armUnloadGuard();

  const existing = jobs.get(opts.code);
  if (
    existing &&
    (existing.pub.status === "uploading" ||
      existing.pub.status === "queued" ||
      existing.pub.status === "finalizing")
  ) {
    return existing.pub;
  }

  const pub = makePub({
    code: opts.code,
    fileName: opts.file.name,
    title: opts.title || opts.file.name.replace(/\.[^.]+$/, "") || "Local film",
    status: "queued",
    pct: 0,
    bytesLoaded: 0,
    bytesTotal: opts.file.size,
    phase: "starting",
    startedAt: Date.now(),
  });

  const job: InternalJob = {
    file: opts.file,
    subtitle: opts.subtitle,
    listeners: new Set(),
    pub,
  };
  jobs.set(opts.code, job);
  emit(job);

  void (async () => {
    try {
      job.pub = makePub({ ...job.pub, status: "uploading" });
      emit(job);
      const result = await uploadFileToR2(opts.file, opts.code, (p) => {
        job.pub = makePub({
          ...job.pub,
          pct: p.pct,
          bytesLoaded: p.bytesLoaded,
          bytesTotal: p.bytesTotal,
          phase: p.phase,
          status: p.phase === "finalizing" ? "finalizing" : "uploading",
        });
        emit(job);
      });
      job.pub = makePub({
        ...job.pub,
        result,
        pct: 100,
        bytesLoaded: result.size || opts.file.size,
        status: "done",
        phase: "finalizing",
      });
      try {
        sessionStorage.setItem(`partmov:media:${opts.code}`, "r2");
        sessionStorage.setItem(`partmov:r2Key:${opts.code}`, result.objectKey);
        sessionStorage.setItem(`partmov:r2Asset:${opts.code}`, result.assetId);
        sessionStorage.setItem(`partmov:r2Title:${opts.code}`, job.pub.title);
        sessionStorage.removeItem(`partmov:r2Uploading:${opts.code}`);
      } catch {
        /* ignore */
      }
      emit(job);
    } catch (err) {
      job.pub = makePub({
        ...job.pub,
        status: "error",
        error: err instanceof Error ? err.message : "Cloud upload failed",
      });
      emit(job);
    }
  })();

  return job.pub;
}

/** Ensure beforeunload is registered (call from lobby/room mount). */
export function ensureR2UnloadGuard() {
  armUnloadGuard();
}

/** Hook: arms unload guard on mount. */
export function useR2UploadUnloadGuard() {
  useEffect(() => {
    armUnloadGuard();
  }, []);
}
