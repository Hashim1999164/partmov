"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getCatalogFilm, isDirectMediaUrl } from "@/lib/catalog";
import {
  assembleBase64Chunks,
  assemblePrefixBase64Chunks,
  encodeFileChunks,
  estimateBytesFromBase64Chunks,
  makeTransferId,
} from "@/lib/media-transfer";
import { materializeFile } from "@/lib/read-blob";
import type { MediaDescriptor, SyncMessage } from "@/lib/sync-protocol";

export type TransferProgress = {
  transferId: string;
  fileName: string;
  kind: "video" | "subtitle";
  pct: number;
  direction: "send" | "receive";
  phase: "reading" | "sending" | "waiting_peer" | "receiving" | "finalizing" | "streaming";
  bytesLoaded?: number;
  bytesTotal?: number;
  startedAt?: number;
  /** Where bytes are going — cloud (R2) vs peer-to-peer */
  via?: "r2" | "peer";
} | null;

type UseRoomMediaArgs = {
  initial?: MediaDescriptor | null;
  /** When false, never fall back to a catalog template. */
  allowCatalogDefault?: boolean;
  /** Room code — required for R2 object keys and signed playback. */
  code?: string;
  send: (msg: SyncMessage) => void;
  /** Live partner presence — read on each transfer tick. */
  getPartnerConnected?: () => boolean;
  onVideoUrl?: (url: string, media: MediaDescriptor) => void;
  onSubtitleReceived?: (label: string, url: string) => void;
  onChanging?: (title: string | null) => void;
};

type HeldVideo = {
  file: File;
  transferId: string;
  desc: MediaDescriptor;
  blobUrl: string;
};

export function useRoomMedia({
  initial = null,
  allowCatalogDefault = false,
  code = "",
  send,
  getPartnerConnected,
  onVideoUrl,
  onSubtitleReceived,
  onChanging,
}: UseRoomMediaArgs) {
  const [media, setMedia] = useState<MediaDescriptor | null>(initial);
  const [videoSrc, setVideoSrc] = useState<string>(() => {
    if (!initial) return "";
    if (initial.kind === "catalog" && initial.id) {
      return getCatalogFilm(initial.id)?.src ?? initial.src ?? "";
    }
    return initial.src ?? "";
  });
  const [poster, setPoster] = useState<string | undefined>(initial?.poster);
  const [transfer, setTransfer] = useState<TransferProgress>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [changingTitle, setChangingTitle] = useState<string | null>(null);

  const blobUrlsRef = useRef<string[]>([]);
  const activeBlobRef = useRef<string | null>(null);
  const heldVideoRef = useRef<HeldVideo | null>(null);
  const pendingReplaceRef = useRef<{
    transferId: string;
    file: File;
    blobUrl: string;
    desc: MediaDescriptor;
    peerReady: boolean;
  } | null>(null);
  const ackCountRef = useRef(new Map<string, number>());
  const getPartnerConnectedRef = useRef(getPartnerConnected);
  getPartnerConnectedRef.current = getPartnerConnected;

  const incomingRef = useRef<
    Map<
      string,
      {
        chunks: Array<string | undefined>;
        total: number;
        fileName: string;
        mime: string;
        kind: "video" | "subtitle";
        label?: string;
        size: number;
        startedAt: number;
        lastProgressiveAt: number;
      }
    >
  >(new Map());

  const trackBlob = useCallback((url: string) => {
    blobUrlsRef.current.push(url);
  }, []);

  const revokeAllExcept = useCallback((keep?: string | null) => {
    for (const u of blobUrlsRef.current) {
      if (keep && u === keep) continue;
      try {
        URL.revokeObjectURL(u);
      } catch {
        /* ignore */
      }
    }
    blobUrlsRef.current = keep ? [keep] : [];
  }, []);

  useEffect(() => {
    return () => {
      for (const u of blobUrlsRef.current) {
        try {
          URL.revokeObjectURL(u);
        } catch {
          /* ignore */
        }
      }
    };
  }, []);

  const applyDescriptor = useCallback(
    (next: MediaDescriptor, srcOverride?: string) => {
      setMedia(next);
      setMediaError(null);
      setChangingTitle(null);
      onChanging?.(null);

      if (next.kind === "browse") {
        revokeAllExcept(null);
        heldVideoRef.current = null;
        activeBlobRef.current = null;
        setPoster(undefined);
        setVideoSrc("");
        onVideoUrl?.("", next);
        return;
      }

      let src = srcOverride ?? next.src ?? "";
      if (next.kind === "hls") {
        src = next.masterPlaylistUrl ?? src;
        if (next.poster) setPoster(next.poster);
      } else if (next.kind === "catalog" && next.id) {
        const film = getCatalogFilm(next.id);
        if (film) {
          src = srcOverride ?? film.src;
          setPoster(film.poster);
        }
      } else if (next.poster) {
        setPoster(next.poster);
      } else {
        setPoster(undefined);
      }
      if (srcOverride) activeBlobRef.current = srcOverride;
      setVideoSrc(src);
      onVideoUrl?.(src, next);
    },
    [onChanging, onVideoUrl, revokeAllExcept],
  );

  const applyR2Film = useCallback(
    async (desc: MediaDescriptor, opts?: { broadcast?: boolean }) => {
      if (!code || !desc.objectKey) {
        setMediaError("Missing cloud film reference");
        return;
      }
      setChangingTitle(desc.title);
      onChanging?.(desc.title);
      setTransfer({
        transferId: desc.assetId || "r2",
        fileName: desc.title,
        kind: "video",
        pct: 0,
        direction: "receive",
        phase: "streaming",
        via: "r2",
        startedAt: Date.now(),
      });
      try {
        const next: MediaDescriptor = {
          ...desc,
          kind: "r2",
          src: undefined,
        };
        revokeAllExcept(null);
        heldVideoRef.current = null;
        activeBlobRef.current = null;
        // Windowed MSE player attaches to the <video>; no full-file progressive URL.
        applyDescriptor(next, "");
        setTransfer(null);
        if (opts?.broadcast) {
          send({
            type: "media_set",
            media: { ...next, src: undefined },
            seq: Date.now(),
          });
        }
      } catch (err) {
        setTransfer(null);
        setMediaError(err instanceof Error ? err.message : "Could not stream from cloud storage");
      }
    },
    [applyDescriptor, code, onChanging, revokeAllExcept, send],
  );

  const commitPendingReplace = useCallback(() => {
    const pending = pendingReplaceRef.current;
    if (!pending) return;
    pendingReplaceRef.current = null;
    revokeAllExcept(pending.blobUrl);
    activeBlobRef.current = pending.blobUrl;
    heldVideoRef.current = {
      file: pending.file,
      transferId: pending.transferId,
      desc: pending.desc,
      blobUrl: pending.blobUrl,
    };
    applyDescriptor(pending.desc, pending.blobUrl);
    send({
      type: "media_set",
      media: { ...pending.desc, src: undefined },
      seq: Date.now(),
    });
    setTransfer(null);
  }, [applyDescriptor, revokeAllExcept, send]);

  const setCatalogFilm = useCallback(
    (id: string, broadcast: boolean) => {
      const film = getCatalogFilm(id);
      if (!film) return;
      const desc: MediaDescriptor = {
        kind: "catalog",
        id: film.id,
        title: film.title,
        src: film.src,
        poster: film.poster,
        credit: film.credit,
        license: film.license,
      };
      revokeAllExcept(null);
      heldVideoRef.current = null;
      applyDescriptor(desc);
      if (broadcast) {
        send({ type: "media_set", media: desc, seq: Date.now() });
      }
    },
    [applyDescriptor, revokeAllExcept, send],
  );

  const setUrlFilm = useCallback(
    (url: string, title: string, broadcast: boolean) => {
      if (!isDirectMediaUrl(url)) {
        setMediaError("Paste a direct HTTPS link ending in .mp4 or .webm");
        return false;
      }
      const desc: MediaDescriptor = {
        kind: "url",
        title: title.trim() || "Pasted film",
        src: url,
      };
      revokeAllExcept(null);
      heldVideoRef.current = null;
      applyDescriptor(desc);
      if (broadcast) {
        send({ type: "media_set", media: desc, seq: Date.now() });
      }
      return true;
    },
    [applyDescriptor, revokeAllExcept, send],
  );

  const setBrowseSite = useCallback(
    (url: string, title: string, broadcast: boolean) => {
      const desc: MediaDescriptor = {
        kind: "browse",
        title: title.trim() || "Website",
        src: url,
      };
      revokeAllExcept(null);
      heldVideoRef.current = null;
      applyDescriptor(desc);
      if (broadcast) {
        send({ type: "media_set", media: desc, seq: Date.now() });
      }
      return true;
    },
    [applyDescriptor, revokeAllExcept, send],
  );

  const sendLocalFile = useCallback(
    async (file: File, opts?: { replace?: boolean }) => {
      if (!file.type.startsWith("video/") && !/\.(mp4|webm|ogg|mov)$/i.test(file.name)) {
        setMediaError("Choose a video file (.mp4, .webm, …)");
        return;
      }
      if (!code) {
        setMediaError("Missing room code for cloud upload");
        return;
      }

      const { r2Status } = await import("@/lib/r2-client");
      const status = await r2Status();
      if (!status.enabled) {
        setMediaError(
          "Cloud storage (R2) is not configured. Films must upload to R2 before streaming — P2P transfer is disabled for multi‑GB files.",
        );
        return;
      }

      const title = file.name.replace(/\.[^.]+$/, "") || "Local film";

      if (opts?.replace || media || videoSrc) {
        send({ type: "media_changing", title, seq: Date.now() });
        setChangingTitle(title);
        onChanging?.(title);
      }

      try {
        const { startR2UploadJob, ensureR2UnloadGuard } = await import("@/lib/r2-upload-job");
        ensureR2UnloadGuard();
        try {
          sessionStorage.setItem(`partmov:media:${code}`, "r2");
          sessionStorage.setItem(`partmov:r2Uploading:${code}`, "1");
          sessionStorage.setItem(`partmov:r2Title:${code}`, title);
        } catch {
          /* ignore */
        }
        // Background job — WatchRoom applies the film when upload completes.
        startR2UploadJob({ code, file, title });
      } catch (err) {
        setTransfer(null);
        setMediaError(err instanceof Error ? err.message : "Cloud upload failed");
      }
    },
    [code, media, onChanging, send, videoSrc],
  );

  const reofferHeldVideo = useCallback(() => {
    const held = heldVideoRef.current;
    if (!held) return;
    void (async () => {
      const { file, desc } = held;
      const transferId = makeTransferId();
      held.transferId = transferId;
      ackCountRef.current.set(transferId, 0);
      send({
        type: "file_offer",
        transferId,
        fileName: file.name,
        mime: file.type || "video/mp4",
        size: file.size,
        kind: "video",
      });
      const sendStarted = Date.now();
      setTransfer({
        transferId,
        fileName: file.name,
        kind: "video",
        pct: 0,
        direction: "send",
        phase: "sending",
        bytesTotal: file.size,
        bytesLoaded: 0,
        startedAt: sendStarted,
      });
      const { chunks, total } = await encodeFileChunks(file);
      for (let i = 0; i < chunks.length; i++) {
        send({ type: "file_chunk", transferId, index: i, total, data: chunks[i] });
        const pct = Math.round(((i + 1) / total) * 100);
        setTransfer({
          transferId,
          fileName: file.name,
          kind: "video",
          pct,
          direction: "send",
          phase: "sending",
          bytesTotal: file.size,
          bytesLoaded: Math.round((pct / 100) * file.size),
          startedAt: sendStarted,
        });
        await new Promise((r) => setTimeout(r, 8));
      }
      send({ type: "file_done", transferId });
      send({ type: "media_set", media: { ...desc, src: undefined }, seq: Date.now() });
      window.setTimeout(() => setTransfer(null), 600);
    })();
  }, [send]);

  const sendSubtitleFile = useCallback(
    async (file: File, label?: string) => {
      let durable = file;
      try {
        durable = await materializeFile(file);
      } catch (err) {
        setMediaError(
          err instanceof Error
            ? err.message
            : "Could not read those subtitles. Try another file.",
        );
        return;
      }
      const transferId = makeTransferId();
      send({
        type: "file_offer",
        transferId,
        fileName: durable.name,
        mime: durable.type || "text/vtt",
        size: durable.size,
        kind: "subtitle",
        label: label || durable.name,
      });
      setTransfer({
        transferId,
        fileName: durable.name,
        kind: "subtitle",
        pct: 0,
        direction: "send",
        phase: "sending",
      });
      const { chunks, total } = await encodeFileChunks(durable);
      for (let i = 0; i < chunks.length; i++) {
        send({ type: "file_chunk", transferId, index: i, total, data: chunks[i] });
        setTransfer({
          transferId,
          fileName: durable.name,
          kind: "subtitle",
          pct: Math.round(((i + 1) / total) * 100),
          direction: "send",
          phase: "sending",
        });
        await new Promise((r) => setTimeout(r, 4));
      }
      send({ type: "file_done", transferId });
      window.setTimeout(() => setTransfer(null), 600);
    },
    [send],
  );

  const handleFileMessage = useCallback(
    (msg: SyncMessage) => {
      if (msg.type === "file_chunk_ack") {
        const prev = ackCountRef.current.get(msg.transferId) ?? 0;
        const next = Math.max(prev, msg.index + 1);
        ackCountRef.current.set(msg.transferId, next);
        setTransfer((t) => {
          if (!t || t.transferId !== msg.transferId || t.direction !== "send") return t;
          const pct = Math.round((next / msg.total) * 100);
          return {
            ...t,
            pct,
            phase: next >= msg.total ? "waiting_peer" : "sending",
            bytesLoaded: t.bytesTotal ? Math.round((pct / 100) * t.bytesTotal) : t.bytesLoaded,
          };
        });
        return;
      }

      if (msg.type === "file_ready") {
        if (msg.kind === "video") {
          const pending = pendingReplaceRef.current;
          if (pending && pending.transferId === msg.transferId) {
            pending.peerReady = true;
          }
        }
        return;
      }

      if (msg.type === "file_offer") {
        incomingRef.current.set(msg.transferId, {
          chunks: [],
          total: 0,
          fileName: msg.fileName,
          mime: msg.mime,
          kind: msg.kind,
          label: msg.label,
          size: msg.size,
          startedAt: Date.now(),
          lastProgressiveAt: 0,
        });
        // Soft changing flag — TransferDock shows progress; don't block the stage forever.
        if (msg.kind === "video") {
          setChangingTitle(msg.fileName.replace(/\.[^.]+$/, "") || "New film");
          onChanging?.(msg.fileName);
        }
        setTransfer({
          transferId: msg.transferId,
          fileName: msg.fileName,
          kind: msg.kind,
          pct: 0,
          direction: "receive",
          phase: "receiving",
          bytesTotal: msg.size,
          bytesLoaded: 0,
          startedAt: Date.now(),
        });
        return;
      }

      if (msg.type === "file_chunk") {
        const bag = incomingRef.current.get(msg.transferId);
        if (!bag) return;
        bag.chunks[msg.index] = msg.data;
        bag.total = msg.total;
        const filled = bag.chunks.filter(Boolean).length;
        const pct = Math.round((filled / msg.total) * 100);
        const bytesLoaded = estimateBytesFromBase64Chunks(bag.chunks, filled) || Math.round((pct / 100) * (bag.size || 0));
        setTransfer({
          transferId: msg.transferId,
          fileName: bag.fileName,
          kind: bag.kind,
          pct,
          direction: "receive",
          phase: pct >= 12 && bag.kind === "video" ? "streaming" : "receiving",
          bytesTotal: bag.size,
          bytesLoaded,
          startedAt: bag.startedAt,
        });

        // Progressive blob playback: once we have a contiguous prefix, start buffering like a stream.
        if (bag.kind === "video" && pct >= 12) {
          const now = Date.now();
          if (now - (bag.lastProgressiveAt || 0) > 900) {
            bag.lastProgressiveAt = now;
            const partial = assemblePrefixBase64Chunks(bag.chunks);
            if (partial && partial.size > 64_000) {
              const typed = new Blob([partial], { type: bag.mime || "video/mp4" });
              const url = URL.createObjectURL(typed);
              trackBlob(url);
              const desc: MediaDescriptor = {
                kind: "file",
                title: bag.fileName.replace(/\.[^.]+$/, "") || "Shared film",
              };
              // Keep changing title soft-cleared once we can stream ahead.
              setChangingTitle(null);
              onChanging?.(null);
              setMedia(desc);
              setMediaError(null);
              setVideoSrc(url);
              activeBlobRef.current = url;
              onVideoUrl?.(url, desc);
            }
          }
        }

        send({
          type: "file_chunk_ack",
          transferId: msg.transferId,
          index: msg.index,
          total: msg.total,
        });
        return;
      }

      if (msg.type === "file_done") {
        const bag = incomingRef.current.get(msg.transferId);
        if (!bag) return;
        setTransfer({
          transferId: msg.transferId,
          fileName: bag.fileName,
          kind: bag.kind,
          pct: 100,
          direction: "receive",
          phase: "finalizing",
          bytesTotal: bag.size,
          bytesLoaded: bag.size,
          startedAt: bag.startedAt,
        });
        const complete = bag.chunks.slice(0, bag.total || bag.chunks.length);
        if (complete.some((c) => !c)) {
          setMediaError("Transfer incomplete — ask the host to resend the film");
          setTransfer(null);
          return;
        }
        const blob = assembleBase64Chunks(complete as string[]);
        const typed = new Blob([blob], { type: bag.mime || "application/octet-stream" });
        const url = URL.createObjectURL(typed);
        trackBlob(url);
        incomingRef.current.delete(msg.transferId);

        if (bag.kind === "video") {
          revokeAllExcept(url);
          activeBlobRef.current = url;
          const desc: MediaDescriptor = {
            kind: "file",
            title: bag.fileName.replace(/\.[^.]+$/, "") || "Shared film",
          };
          applyDescriptor(desc, url);
          send({ type: "file_ready", transferId: msg.transferId, kind: "video" });
        } else {
          onSubtitleReceived?.(bag.label || bag.fileName, url);
          send({ type: "file_ready", transferId: msg.transferId, kind: "subtitle" });
        }
        setTransfer(null);
      }
    },
    [applyDescriptor, onChanging, onSubtitleReceived, onVideoUrl, revokeAllExcept, send, trackBlob],
  );

  const onMediaFromPeer = useCallback(
    (next: MediaDescriptor) => {
      if (next.kind === "r2" && next.objectKey) {
        void applyR2Film(next, { broadcast: false });
        return;
      }
      if (next.kind === "file" && !next.src) {
        setMedia(next);
        setChangingTitle(null);
        onChanging?.(null);
        return;
      }
      if (next.kind === "catalog" && next.id) {
        setCatalogFilm(next.id, false);
        return;
      }
      applyDescriptor(next);
    },
    [applyDescriptor, applyR2Film, onChanging, setCatalogFilm],
  );

  const onMediaChanging = useCallback(
    (title: string) => {
      setChangingTitle(title);
      onChanging?.(title);
    },
    [onChanging],
  );

  const onMediaClear = useCallback(() => {
    revokeAllExcept(null);
    heldVideoRef.current = null;
    setVideoSrc("");
    setMedia(null);
    setPoster(undefined);
  }, [revokeAllExcept]);

  const currentMediaForWelcome = useCallback((): MediaDescriptor | null => {
    if (!media) return null;
    if (media.kind === "file" || media.kind === "r2") return { ...media, src: undefined };
    return media;
  }, [media]);

  const onVideoError = useCallback(() => {
    if (media?.kind === "r2") {
      setMediaError("Cloud stream stalled — try seeking or reloading the film");
      return;
    }
    if (!media || media.kind !== "catalog" || !media.id) {
      setMediaError("Could not load this film");
      return;
    }
    const film = getCatalogFilm(media.id);
    if (film?.fallbackSrc && videoSrc !== film.fallbackSrc) {
      setVideoSrc(film.fallbackSrc);
      setMediaError(null);
      return;
    }
    setMediaError("Could not load this film");
  }, [media, videoSrc]);

  const wipeSession = useCallback(() => {
    revokeAllExcept(null);
    heldVideoRef.current = null;
    pendingReplaceRef.current = null;
    incomingRef.current.clear();
    ackCountRef.current.clear();
    activeBlobRef.current = null;
    setTransfer(null);
    setVideoSrc("");
    setMedia(null);
    setPoster(undefined);
    setMediaError(null);
    setChangingTitle(null);
    onChanging?.(null);
  }, [onChanging, revokeAllExcept]);

  // Hydrate initial catalog only when explicitly allowed (legacy).
  useEffect(() => {
    if (initial || !allowCatalogDefault) return;
    void initial;
  }, [allowCatalogDefault, initial]);

  return {
    media,
    videoSrc,
    poster,
    transfer,
    mediaError,
    changingTitle,
    setCatalogFilm,
    setUrlFilm,
    setBrowseSite,
    sendLocalFile,
    sendSubtitleFile,
    handleFileMessage,
    onMediaFromPeer,
    onMediaChanging,
    onMediaClear,
    onVideoError,
    applyDescriptor,
    applyR2Film,
    wipeSession,
    reofferHeldVideo,
    currentMediaForWelcome,
    hasPlayableMedia:
      Boolean(videoSrc) || media?.kind === "browse" || (media?.kind === "r2" && Boolean(media.objectKey)),
  };
}
