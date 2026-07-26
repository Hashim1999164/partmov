"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CATALOG, getCatalogFilm, isDirectMediaUrl } from "@/lib/catalog";
import {
  assembleBase64Chunks,
  encodeFileChunks,
  makeTransferId,
} from "@/lib/media-transfer";
import type { MediaDescriptor, SyncMessage } from "@/lib/sync-protocol";

type TransferProgress = {
  transferId: string;
  fileName: string;
  kind: "video" | "subtitle";
  pct: number;
  direction: "send" | "receive";
} | null;

type UseRoomMediaArgs = {
  initial?: MediaDescriptor | null;
  send: (msg: SyncMessage) => void;
  onVideoUrl?: (url: string, media: MediaDescriptor) => void;
  onSubtitleReceived?: (label: string, url: string) => void;
};

export function useRoomMedia({
  initial,
  send,
  onVideoUrl,
  onSubtitleReceived,
}: UseRoomMediaArgs) {
  const [media, setMedia] = useState<MediaDescriptor | null>(
    initial ?? CATALOG[0] ?? null,
  );
  const [videoSrc, setVideoSrc] = useState<string>(() => {
    if (!initial) return CATALOG[0]?.src ?? "";
    if (initial.kind === "catalog" && initial.id) {
      return getCatalogFilm(initial.id)?.src ?? initial.src ?? "";
    }
    return initial.src ?? "";
  });
  const [poster, setPoster] = useState<string | undefined>(
    initial?.poster ?? CATALOG[0]?.poster,
  );
  const [transfer, setTransfer] = useState<TransferProgress>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const blobUrlsRef = useRef<string[]>([]);
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
      }
    >
  >(new Map());

  const revokeLater = useCallback((url: string) => {
    blobUrlsRef.current.push(url);
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
      let src = srcOverride ?? next.src ?? "";
      if (next.kind === "catalog" && next.id) {
        const film = getCatalogFilm(next.id);
        if (film) {
          src = srcOverride ?? film.src;
          setPoster(film.poster);
        }
      } else if (next.poster) {
        setPoster(next.poster);
      }
      setVideoSrc(src);
      onVideoUrl?.(src, next);
    },
    [onVideoUrl],
  );

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
      applyDescriptor(desc);
      if (broadcast) {
        send({ type: "media_set", media: desc, seq: Date.now() });
      }
    },
    [applyDescriptor, send],
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
      applyDescriptor(desc);
      if (broadcast) {
        send({ type: "media_set", media: desc, seq: Date.now() });
      }
      return true;
    },
    [applyDescriptor, send],
  );

  const sendLocalFile = useCallback(
    async (file: File) => {
      if (!file.type.startsWith("video/") && !/\.(mp4|webm|ogg|mov)$/i.test(file.name)) {
        setMediaError("Choose a video file (.mp4, .webm, …)");
        return;
      }
      const transferId = makeTransferId();
      const localUrl = URL.createObjectURL(file);
      revokeLater(localUrl);
      const desc: MediaDescriptor = {
        kind: "file",
        title: file.name.replace(/\.[^.]+$/, "") || "Local film",
        src: localUrl,
      };
      applyDescriptor(desc, localUrl);
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
      });
      const { chunks, total } = await encodeFileChunks(file);
      for (let i = 0; i < chunks.length; i++) {
        send({
          type: "file_chunk",
          transferId,
          index: i,
          total,
          data: chunks[i],
        });
        setTransfer({
          transferId,
          fileName: file.name,
          kind: "video",
          pct: Math.round(((i + 1) / total) * 100),
          direction: "send",
        });
        await new Promise((r) => setTimeout(r, 0));
      }
      send({ type: "file_done", transferId });
      send({
        type: "media_set",
        media: { ...desc, src: undefined },
        seq: Date.now(),
      });
      window.setTimeout(() => setTransfer(null), 800);
    },
    [applyDescriptor, revokeLater, send],
  );

  const sendSubtitleFile = useCallback(
    async (file: File, label?: string) => {
      const transferId = makeTransferId();
      send({
        type: "file_offer",
        transferId,
        fileName: file.name,
        mime: file.type || "text/vtt",
        size: file.size,
        kind: "subtitle",
        label: label || file.name,
      });
      setTransfer({
        transferId,
        fileName: file.name,
        kind: "subtitle",
        pct: 0,
        direction: "send",
      });
      const { chunks, total } = await encodeFileChunks(file);
      for (let i = 0; i < chunks.length; i++) {
        send({
          type: "file_chunk",
          transferId,
          index: i,
          total,
          data: chunks[i],
        });
        setTransfer({
          transferId,
          fileName: file.name,
          kind: "subtitle",
          pct: Math.round(((i + 1) / total) * 100),
          direction: "send",
        });
        await new Promise((r) => setTimeout(r, 0));
      }
      send({ type: "file_done", transferId });
      window.setTimeout(() => setTransfer(null), 600);
    },
    [send],
  );

  const handleFileMessage = useCallback(
    (msg: SyncMessage) => {
      if (msg.type === "file_offer") {
        incomingRef.current.set(msg.transferId, {
          chunks: [],
          total: 0,
          fileName: msg.fileName,
          mime: msg.mime,
          kind: msg.kind,
          label: msg.label,
        });
        setTransfer({
          transferId: msg.transferId,
          fileName: msg.fileName,
          kind: msg.kind,
          pct: 0,
          direction: "receive",
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
        });
        return;
      }

      if (msg.type === "file_done") {
        const bag = incomingRef.current.get(msg.transferId);
        if (!bag) return;
        const blob = assembleBase64Chunks(bag.chunks);
        const typed = new Blob([blob], { type: bag.mime || "application/octet-stream" });
        const url = URL.createObjectURL(typed);
        revokeLater(url);
        incomingRef.current.delete(msg.transferId);
        setTransfer(null);

        if (bag.kind === "video") {
          const desc: MediaDescriptor = {
            kind: "file",
            title: bag.fileName.replace(/\.[^.]+$/, "") || "Shared film",
            src: url,
          };
          applyDescriptor(desc, url);
        } else {
          onSubtitleReceived?.(bag.label || bag.fileName, url);
        }
      }
    },
    [applyDescriptor, onSubtitleReceived, revokeLater],
  );

  const onMediaFromPeer = useCallback(
    (next: MediaDescriptor) => {
      if (next.kind === "file" && !next.src) {
        // bytes arrive via file_* messages; descriptor is cosmetic until then
        setMedia(next);
        return;
      }
      if (next.kind === "catalog" && next.id) {
        setCatalogFilm(next.id, false);
        return;
      }
      applyDescriptor(next);
    },
    [applyDescriptor, setCatalogFilm],
  );

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

  /** Revoke blobs and clear session media — nothing was stored on Partmov servers. */
  const wipeSession = useCallback(() => {
    for (const u of blobUrlsRef.current) {
      try {
        URL.revokeObjectURL(u);
      } catch {
        /* ignore */
      }
    }
    blobUrlsRef.current = [];
    incomingRef.current.clear();
    setTransfer(null);
    setVideoSrc("");
    setMedia(null);
    setPoster(undefined);
    setMediaError(null);
  }, []);

  return {
    media,
    videoSrc,
    poster,
    transfer,
    mediaError,
    setCatalogFilm,
    setUrlFilm,
    sendLocalFile,
    sendSubtitleFile,
    handleFileMessage,
    onMediaFromPeer,
    onVideoError,
    applyDescriptor,
    wipeSession,
  };
}
