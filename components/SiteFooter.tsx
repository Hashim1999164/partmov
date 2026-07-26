import Link from "next/link";
import { navItems } from "./nav-items";

export function SiteFooter() {
  return (
    <footer className="footer">
      <div className="shell footer__inner">
        <div className="stack stack--sm">
          <span className="footer__brand">Partmov</span>
          <p className="footer__note">
            A private cinema for two. Blueprint document, v1.0 — every component in this design is free
            software that a two-person team can self-host on a single machine.
          </p>
        </div>
        <div className="footer__links">
          {navItems.slice(1).map((item) => (
            <Link key={item.href} href={item.href}>
              {item.label}
            </Link>
          ))}
        </div>
      </div>
    </footer>
  );
}
