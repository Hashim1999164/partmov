"use client";

import { useCallback, useState } from "react";
import { fileToSubtitleVtt } from "@/lib/media-transfer";
import type { SubtitleStyle, SubtitleTrackInfo } from "@/lib/sync-protocol";

const DEFAULT_STYLE: SubtitleStyle = { size: "m", offset: 0, contrast: true };

export function useSubtitles() {
  const [tracks, setTracks] = useState<SubtitleTrackInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [style, setStyle] = useState<SubtitleStyle>(() => {
    if (typeof window === "undefined") return DEFAULT_STYLE;
    try {
      const raw = localStorage.getItem("partmov:subtitles");
      if (raw) return { ...DEFAULT_STYLE, ...JSON.parse(raw) };
    } catch {
      /* ignore */
    }
    return DEFAULT_STYLE;
  });
  const [visible, setVisible] = useState(true);

  const persistStyle = useCallback((next: SubtitleStyle) => {
    setStyle(next);
    try {
      localStorage.setItem("partmov:subtitles", JSON.stringify(next));
    } catch {
      /* ignore */
    }
  }, []);

  const addTrackFromFile = useCallback(async (file: File) => {
    const { label, url } = await fileToSubtitleVtt(file);
    const id = `sub_${Date.now().toString(36)}`;
    const track: SubtitleTrackInfo = {
      id,
      label,
      language: "und",
      url,
    };
    setTracks((prev) => [...prev, track]);
    setActiveId(id);
    setVisible(true);
    return track;
  }, []);

  const addTrackFromUrl = useCallback((label: string, url: string) => {
    const id = `sub_${Date.now().toString(36)}`;
    const track: SubtitleTrackInfo = { id, label, language: "und", url };
    setTracks((prev) => [...prev, track]);
    setActiveId(id);
    setVisible(true);
    return track;
  }, []);

  const cycleCaptions = useCallback(() => {
    if (!tracks.length) {
      setVisible((v) => !v);
      return;
    }
    if (!visible || !activeId) {
      setVisible(true);
      setActiveId(tracks[0].id);
      return;
    }
    const idx = tracks.findIndex((t) => t.id === activeId);
    if (idx < tracks.length - 1) {
      setActiveId(tracks[idx + 1].id);
    } else {
      setActiveId(null);
      setVisible(false);
    }
  }, [activeId, tracks, visible]);

  const clearTracks = useCallback(() => {
    for (const t of tracks) {
      try {
        URL.revokeObjectURL(t.url);
      } catch {
        /* ignore */
      }
    }
    setTracks([]);
    setActiveId(null);
    setVisible(false);
  }, [tracks]);

  return {
    tracks,
    activeId,
    setActiveId,
    style,
    persistStyle,
    visible,
    setVisible,
    addTrackFromFile,
    addTrackFromUrl,
    cycleCaptions,
    clearTracks,
  };
}
