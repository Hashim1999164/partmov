"use client";

import { useEffect, useRef, useState } from "react";
import type { ChatLine } from "@/hooks/useRoomSync";

const REACTIONS = ["♥", "👏", "🔥", "😮", "😂", "✨"] as const;

type Props = {
  chat: ChatLine[];
  partnerTyping: boolean;
  partnerName: string | null;
  onSend: (body: string) => void;
  onReaction: (glyph: string) => void;
  onTyping: (on: boolean) => void;
};

export function ChatRail({ chat, partnerTyping, partnerName, onSend, onReaction, onTyping }: Props) {
  const [input, setInput] = useState("");
  const endRef = useRef<HTMLDivElement | null>(null);
  const typingTimer = useRef<number | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const body = input.trim();
    if (!body) return;
    onSend(body);
    setInput("");
    onTyping(false);
  }

  return (
    <div className="rail-panel chat-rail">
      <h3>Chat</h3>
      <div className="chat-rail__log">
        {chat.length === 0 && <p className="rail-panel__muted">Say something soft — session only.</p>}
        {chat.map((line) => (
          <div key={line.id} className="chat-rail__line">
            <strong style={{ color: line.color }}>{line.name}</strong>
            <span>{line.body}</span>
          </div>
        ))}
        {partnerTyping && <p className="chat-rail__typing">{partnerName ?? "Partner"} is typing…</p>}
        <div ref={endRef} />
      </div>

      <div className="chat-rail__reacts">
        {REACTIONS.map((g) => (
          <button key={g} type="button" onClick={() => onReaction(g)} aria-label={`React ${g}`}>
            {g}
          </button>
        ))}
      </div>

      <form className="chat-rail__form" onSubmit={submit}>
        <input
          value={input}
          maxLength={280}
          placeholder="Message…"
          onChange={(e) => {
            setInput(e.target.value);
            onTyping(true);
            if (typingTimer.current) window.clearTimeout(typingTimer.current);
            typingTimer.current = window.setTimeout(() => onTyping(false), 1200);
          }}
        />
        <button type="submit" className="btn btn--ghost">
          Send
        </button>
      </form>
    </div>
  );
}
