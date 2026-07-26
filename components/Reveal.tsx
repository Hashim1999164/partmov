"use client";

import { useEffect, useRef, useState } from "react";

type RevealProps = {
  children: React.ReactNode;
  /** Stagger delay in milliseconds. */
  delay?: number;
  className?: string;
  as?: "div" | "section" | "li" | "header";
};

/**
 * Entrance animation that never gates content on it: the element is revealed as
 * soon as it is measured near the viewport, and unconditionally after a short
 * failsafe, so no environment can leave text stuck at opacity 0.
 */
export function Reveal({ children, delay = 0, className = "", as = "div" }: RevealProps) {
  const ref = useRef<HTMLElement | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (shown) return;
    const node = ref.current;
    if (!node) {
      setShown(true);
      return;
    }

    let frame = 0;

    const check = () => {
      frame = 0;
      const rect = node.getBoundingClientRect();
      if (rect.top < window.innerHeight * 0.94 && rect.bottom > -1) setShown(true);
    };

    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(check);
    };

    check();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    const failsafe = window.setTimeout(() => setShown(true), 1400);

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.clearTimeout(failsafe);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [shown]);

  const Tag = as as "div";

  return (
    <Tag
      ref={ref as React.RefObject<HTMLDivElement>}
      className={`reveal${shown ? " reveal--in" : ""}${className ? ` ${className}` : ""}`}
      style={delay ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </Tag>
  );
}
