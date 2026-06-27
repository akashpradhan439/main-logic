"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion, useReducedMotion } from "framer-motion";
import { useState } from "react";

const NAV_ITEMS = [
  { href: "/", label: "Home" },
  { href: "/nirjalaekadashi", label: "Nirjala Ekadashi" },
  { href: "/annadanam", label: "Annadanam" },
  { href: "/personal", label: "Personal" },
  { href: "/cow-research", label: "Cow Research" },
  { href: "/donate", label: "Donate" },
] as const;

export default function Header() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const reduceMotion = useReducedMotion();

  return (
    <header className="sticky top-0 z-50 border-b border-sage-100/50 bg-white/80 backdrop-blur-md">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6 lg:px-8">
        {/* Logo */}
        <Link
          href="/"
          className="flex flex-col leading-tight"
          aria-label="ISKCON Gurugram Sector 57 — Home"
        >
          <span className="font-serif text-2xl font-semibold text-sage-700">
            ISKCON
          </span>
          <span className="text-[10px] uppercase tracking-[0.2em] text-sage-600">
            Gurugram Sector 57
          </span>
        </Link>

        {/* Desktop nav (6 inline links) */}
        <nav
          aria-label="Primary navigation"
          className="hidden md:flex md:items-center md:gap-6"
        >
          {NAV_ITEMS.map((item) => {
            const isActive = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                className={`text-sm font-medium transition-colors ${
                  isActive
                    ? "text-sage-700 underline underline-offset-4"
                    : "text-slate-700 hover:text-sage-700"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        {/* Donate CTA on right (desktop) — animated motion.button wrapping Link */}
        <motion.button
          type="button"
          whileHover={reduceMotion ? undefined : { scale: 1.05, rotateX: 8 }}
          whileTap={reduceMotion ? undefined : { scale: 0.97 }}
          style={{ perspective: "600px", transformStyle: "preserve-3d" }}
          className="hidden md:inline-flex"
          aria-label="Donate to ISKCON Gurugram Sector 57"
        >
          <Link
            href="/donate"
            className="rounded-full bg-sage-600 px-5 py-2 text-sm font-semibold text-ivory-50 shadow-sm transition-colors hover:bg-sage-700"
          >
            Donate
          </Link>
        </motion.button>

        {/* Mobile hamburger */}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="mobile-nav"
          aria-label="Toggle navigation"
          className="inline-flex items-center justify-center rounded-md p-2 text-slate-700 transition-colors hover:bg-sage-50 md:hidden"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            {open ? (
              <>
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </>
            ) : (
              <>
                <line x1="3" y1="6" x2="21" y2="6" />
                <line x1="3" y1="12" x2="21" y2="12" />
                <line x1="3" y1="18" x2="21" y2="18" />
              </>
            )}
          </svg>
        </button>
      </div>

      {/* Mobile panel */}
      <motion.div
        id="mobile-nav"
        initial={false}
        animate={
          open
            ? { height: "auto", opacity: 1 }
            : { height: 0, opacity: 0 }
        }
        transition={{
          duration: reduceMotion ? 0 : 0.25,
          ease: "easeOut",
        }}
        className="overflow-hidden md:hidden"
      >
        <nav
          aria-label="Mobile navigation"
          className="flex flex-col gap-1 border-t border-sage-100/50 px-4 pb-4 pt-2"
        >
          {NAV_ITEMS.map((item) => {
            const isActive = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                aria-current={isActive ? "page" : undefined}
                className={`rounded-md px-3 py-2 text-base font-medium transition-colors ${
                  isActive
                    ? "bg-sage-50 text-sage-700"
                    : "text-slate-700 hover:bg-sage-50 hover:text-sage-700"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
          <Link
            href="/donate"
            onClick={() => setOpen(false)}
            className="mt-2 rounded-full bg-sage-600 px-4 py-2 text-center text-sm font-semibold text-ivory-50 hover:bg-sage-700"
          >
            Donate now
          </Link>
        </nav>
      </motion.div>
    </header>
  );
}
