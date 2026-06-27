"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";

const HEADLINE_WORDS = ["Rejuvenate", "yourself", "spiritually"] as const;

const FEATHER_MASK_STYLE = {
  maskImage:
    "radial-gradient(ellipse 80% 70% at center, black 40%, transparent 80%), " +
    "linear-gradient(to bottom, black 0%, black 55%, transparent 100%)",
  WebkitMaskImage:
    "radial-gradient(ellipse 80% 70% at center, black 40%, transparent 80%), " +
    "linear-gradient(to bottom, black 0%, black 55%, transparent 100%)",
  maskComposite: "intersect",
  WebkitMaskComposite: "source-in",
} as const;

export default function HeroVideo() {
  const reduceMotion = useReducedMotion();

  // Per-word stagger reveal for the headline. Reduced-motion collapses to a
  // simple fade so nothing drifts or bounces on the screen.
  const wordReveal = (index: number) => ({
    initial: reduceMotion ? { opacity: 0 } : { opacity: 0, y: 32 },
    animate: { opacity: 1, y: 0 },
    transition: {
      duration: reduceMotion ? 0.2 : 0.7,
      delay: 0.15 + index * 0.2,
      ease: "easeOut" as const,
    },
  });

  const fadeUp = (delay: number) => ({
    initial: reduceMotion ? { opacity: 0 } : { opacity: 0, y: 16 },
    animate: { opacity: 1, y: 0 },
    transition: {
      duration: reduceMotion ? 0.2 : 0.5,
      delay,
      ease: "easeOut" as const,
    },
  });

  return (
    <section
      aria-label="Hero"
      className="relative isolate flex min-h-[90vh] w-full items-center justify-center overflow-hidden"
    >
      {/* Layer 1 — base gradient + soft radial highlight */}
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-20 bg-gradient-to-br from-ivory-50 via-ivory-100 to-sage-50"
      />
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-10"
        style={{
          backgroundImage:
            "radial-gradient(ellipse at center, rgba(255,255,255,0.6) 0%, rgba(255,255,255,0) 60%)",
        }}
      />

      {/* Layer 2 — single background video with feathered mask + dim */}
      <div
        aria-hidden="true"
        className="absolute inset-0 z-0"
        style={FEATHER_MASK_STYLE}
      >
        <video
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
          aria-hidden="true"
          src="/iskcon-site/videos/hero.mp4"
          className="h-full w-full object-cover"
          style={{ filter: "brightness(0.55) saturate(0.9)" }}
        />
      </div>

      {/* Layer 3 — dim overlay + bottom fade for headline contrast */}
      <div
        aria-hidden="true"
        className="absolute inset-0 z-10 bg-black/35 bg-gradient-to-b from-transparent via-transparent to-black/40"
      />

      {/* Layer 4 — headline + CTAs */}
      <div className="relative z-20 mx-auto flex max-w-5xl flex-col items-center px-4 text-center sm:px-6">
        <motion.span
          {...fadeUp(0)}
          className="text-xs uppercase tracking-[0.4em] text-ivory-50/90 sm:text-sm"
        >
          ISKCON &middot; Secunderabad
        </motion.span>

        <h1 className="mt-6 font-serif text-4xl font-medium leading-[1.05] tracking-tight text-ivory-50 sm:text-6xl md:text-7xl lg:text-8xl">
          {HEADLINE_WORDS.map((word, index) => (
            <motion.span
              key={word}
              {...wordReveal(index)}
              className="mx-2 inline-block"
            >
              {word}
            </motion.span>
          ))}
        </h1>

        <motion.p
          {...fadeUp(0.95)}
          className="mt-6 max-w-2xl text-base font-light text-ivory-50/85 sm:text-lg"
        >
          A temple for the soul &middot; A refuge for the heart
        </motion.p>

        <motion.div
          {...fadeUp(1.15)}
          className="mt-10 flex flex-wrap items-center justify-center gap-4"
        >
          <motion.div
            whileHover={reduceMotion ? undefined : { scale: 1.05, rotateX: 6 }}
            whileTap={reduceMotion ? undefined : { scale: 0.97 }}
            transition={{ type: "spring", stiffness: 300, damping: 20 }}
            style={{ perspective: "600px", transformStyle: "preserve-3d" }}
            className="inline-flex"
          >
            <Link
              href="/nirjalaekadashi"
              className="rounded-full bg-sage-600 px-6 py-3 text-sm font-semibold text-ivory-50 shadow-sm transition-colors hover:bg-sage-700"
            >
              Explore Nirjala Ekadashi
            </Link>
          </motion.div>
          <motion.div
            whileHover={reduceMotion ? undefined : { scale: 1.05, rotateX: 6 }}
            whileTap={reduceMotion ? undefined : { scale: 0.97 }}
            transition={{ type: "spring", stiffness: 300, damping: 20 }}
            style={{ perspective: "600px", transformStyle: "preserve-3d" }}
            className="inline-flex"
          >
            <Link
              href="/donate"
              className="rounded-full border border-ivory-50/70 px-6 py-3 text-sm font-semibold text-ivory-50 transition-colors hover:bg-ivory-50/10"
            >
              Donate
            </Link>
          </motion.div>
        </motion.div>
      </div>
    </section>
  );
}
