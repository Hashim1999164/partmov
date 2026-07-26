"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { navItems } from "./nav-items";

export function SiteNav() {
  const pathname = usePathname();
  const [pinned, setPinned] = useState(false);

  useEffect(() => {
    const onScroll = () => setPinned(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <nav className={`nav${pinned ? " nav--pinned" : ""}`}>
      <div className="shell nav__inner">
        <Link href="/" className="nav__brand" aria-label="Partmov home">
          <span className="nav__mark" aria-hidden="true" />
          Partmov
        </Link>
        <div className="nav__links">
          {navItems.map((item) => {
            const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`nav__link${active ? " nav__link--active" : ""}`}
                aria-current={active ? "page" : undefined}
              >
                {item.label}
              </Link>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
