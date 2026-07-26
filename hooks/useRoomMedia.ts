"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getCatalogFilm, isDirectMediaUrl } from "@/lib/catalog";
import {
  assembleBase64Chunks,
  encodeFileChunks,
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
  phase: "reading" | "sending" | "waiting_peer" | "receiving" | "finalizing";
} | null;

type UseRoomMediaArgs = {
  initial?: MediaDescriptor | null;
  /** When false, never fall back to a catalog template. */
  allowCatalogDefault?: boolean;
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
        chunks: string[];
        total: number;
        fileName: string;
        mime: string;
        kind: "video" | "subtitle";
        label?: string;
        size: number;
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

      let durable = file;
      try {
        setTransfer({
          transferId: "read",
          fileName: file.name,
          kind: "video",
          pct: 0,
          direction: "send",
          phase: "reading",
        });
        durable = await materializeFile(file, (pct) => {
          setTransfer({
            transferId: "read",
            fileName: file.name,
            kind: "video",
            pct,
            direction: "send",
            phase: "reading",
          });
        });
      } catch (err) {
        setTransfer(null);
        setMediaError(
          err instanceof Error
            ? err.message
            : "Could not read this video. Try copying it to Downloads and pick it again.",
        );
        return;
      }

      const replace = Boolean(opts?.replace ?? Boolean(media || videoSrc));
      const transferId = makeTransferId();
      const localUrl = URL.createObjectURL(durable);
      trackBlob(localUrl);
      const desc: MediaDescriptor = {
        kind: "file",
        title: durable.name.replace(/\.[^.]+$/, "") || "Local film",
      };

      if (replace) {
        setChangingTitle(desc.title);
        onChanging?.(desc.title);
        send({ type: "media_changing", title: desc.title, seq: Date.now() });
        pendingReplaceRef.current = {
          transferId,
          file: durable,
          blobUrl: localUrl,
          desc,
          peerReady: !getPartnerConnectedRef.current?.(),
        };
      } else {
        activeBlobRef.current = localUrl;
        heldVideoRef.current = { file: durable, transferId, desc, blobUrl: localUrl };
        applyDescriptor(desc, localUrl);
      }

      ackCountRef.current.set(transferId, 0);
      send({
        type: "file_offer",
        transferId,
        fileName: durable.name,
        mime: durable.type || "video/mp4",
        size: durable.size,
        kind: "video",
      });
      setTransfer({
        transferId,
        fileName: durable.name,
        kind: "video",
        pct: 0,
        direction: "send",
        phase: "reading",
      });

      const { chunks, total } = await encodeFileChunks(durable);
      for (let i = 0; i < chunks.length; i++) {
        send({
          type: "file_chunk",
          transferId,
          index: i,
          total,
          data: chunks[i],
        });
        const acked = ackCountRef.current.get(transferId) ?? 0;
        const sentPct = Math.round(((i + 1) / total) * 100);
        const linked = Boolean(getPartnerConnectedRef.current?.());
        const ackPct = linked ? Math.round((acked / total) * 100) : sentPct;
        setTransfer({
          transferId,
          fileName: durable.name,
          kind: "video",
          pct: Math.min(sentPct, Math.max(ackPct, Math.round(sentPct * 0.85))),
          direction: "send",
          phase: "sending",
        });
        // Yield so UI + PeerJS can flush; slows large floods that cause guest lag.
        await new Promise((r) => setTimeout(r, linked ? 8 : 0));
      }
      send({ type: "file_done", transferId });

      if (!getPartnerConnectedRef.current?.()) {
        if (replace) commitPendingReplace();
        else {
          send({ type: "media_set", media: { ...desc, src: undefined }, seq: Date.now() });
          setTransfer(null);
        }
        return;
      }

      setTransfer({
        transferId,
        fileName: durable.name,
        kind: "video",
        pct: 99,
        direction: "send",
        phase: "waiting_peer",
      });

      // Wait for guest file_ready (or timeout → commit anyway so host is not stuck).
      const started = Date.now();
      while (Date.now() - started < 45_000) {
        const pending = pendingReplaceRef.current;
        if (!replace) break;
        if (pending && pending.transferId === transferId && pending.peerReady) break;
        if (!getPartnerConnectedRef.current?.()) break;
        await new Promise((r) => setTimeout(r, 120));
      }

      if (replace) commitPendingReplace();
      else {
        send({ type: "media_set", media: { ...desc, src: undefined }, seq: Date.now() });
        setTransfer(null);
      }
    },
    [applyDescriptor, commitPendingReplace, media, onChanging, send, trackBlob, videoSrc],
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
      setTransfer({
        transferId,
        fileName: file.name,
        kind: "video",
        pct: 0,
        direction: "send",
        phase: "sending",
      });
      const { chunks, total } = await encodeFileChunks(file);
      for (let i = 0; i < chunks.length; i++) {
        send({ type: "file_chunk", transferId, index: i, total, data: chunks[i] });
        setTransfer({
          transferId,
          fileName: file.name,
          kind: "video",
          pct: Math.round(((i + 1) / total) * 100),
          direction: "send",
          phase: "sending",
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
        setTransfer((t) =>
          t && t.transferId === msg.transferId && t.direction === "send"
            ? {
                ...t,
                pct: Math.round((next / msg.total) * 100),
                phase: next >= msg.total ? "waiting_peer" : "sending",
              }
            : t,
        );
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
        });
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
        });
        return;
      }

      if (msg.type === "file_chunk") {
        const bag = incomingRef.current.get(msg.transferId);
        if (!bag) return;
        bag.chunks[msg.index] = msg.data;
        bag.total = msg.total;
        const filled = bag.chunks.filter(Boolean).length;
        setTransfer({
          transferId: msg.transferId,
          fileName: bag.fileName,
          kind: bag.kind,
          pct: Math.round((filled / msg.total) * 100),
          direction: "receive",
          phase: "receiving",
        });
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
        });
        const blob = assembleBase64Chunks(bag.chunks);
        const typed = new Blob([blob], { type: bag.mime || "application/octet-stream" });
        const url = URL.createObjectURL(typed);
        trackBlob(url);
        incomingRef.current.delete(msg.transferId);

        if (bag.kind === "video") {
          // Wait for host media_set / commit — but apply when we have bytes so guest is ready.
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
    [applyDescriptor, onChanging, onSubtitleReceived, revokeAllExcept, send, trackBlob],
  );

  const onMediaFromPeer = useCallback(
    (next: MediaDescriptor) => {
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
    [applyDescriptor, onChanging, setCatalogFilm],
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
    if (media.kind === "file") return { ...media, src: undefined };
    return media;
  }, [media]);

  const onVideoError = useCallback(() => {
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
    wipeSession,
    reofferHeldVideo,
    currentMediaForWelcome,
    hasPlayableMedia: Boolean(videoSrc) || media?.kind === "browse",
  };
}
