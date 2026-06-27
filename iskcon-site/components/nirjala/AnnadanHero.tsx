"use client";

import { motion, useReducedMotion } from "framer-motion";

const HEADING_WORDS = ["Annadan", "is", "Maha", "Daan"] as const;

export default function AnnadanHero() {
  const reduceMotion = useReducedMotion();

  const wordReveal = (index: number) => ({
    initial: reduceMotion ? { opacity: 0 } : { opacity: 0, y: 28 },
    animate: { opacity: 1, y: 0 },
    transition: {
      duration: reduceMotion ? 0.2 : 0.65,
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
      aria-labelledby="annadan-hero-heading"
      className="relative isolate overflow-hidden bg-gradient-to-b from-ivory-50 via-ivory-100 to-sage-50 py-20 sm:py-28"
    >
      {/* Floating decorative badge — top-right */}
      <motion.div
        initial={false}
        animate={
          reduceMotion ? { y: 0 } : { y: [0, -8, 0] }
        }
        transition={{
          duration: 5,
          repeat: Infinity,
          repeatType: "mirror",
          ease: "easeInOut",
        }}
        className="pointer-events-none absolute right-4 top-6 hidden sm:block"
        aria-hidden="true"
      >
        <div className="inline-flex items-center gap-2 rounded-full border border-sage-100 bg-white/70 px-4 py-2 text-xs font-semibold uppercase tracking-[0.2em] text-sage-700 shadow-sm backdrop-blur-sm">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            {/* Lotus */}
            <path d="M12 3 C9 7 6 9 6 13 C6 17 9 19 12 19 C15 19 18 17 18 13 C18 9 15 7 12 3 Z" />
            <path d="M12 19 L12 21" />
            <path d="M3 13 C5 12 7 13 8 15" opacity="0.7" />
            <path d="M21 13 C19 12 17 13 16 15" opacity="0.7" />
          </svg>
          Nirjala Ekadashi 2026
        </div>
      </motion.div>

      <div className="relative mx-auto flex max-w-5xl flex-col items-center px-4 text-center sm:px-6">
        {/* Eyebrow */}
        <motion.span
          {...fadeUp(0)}
          className="text-xs font-semibold uppercase tracking-[0.3em] text-sage-600 sm:text-sm"
        >
          ISKCON &middot; Gurugram Sector 57
        </motion.span>

        {/* Main heading — staggered per word */}
        <h1
          id="annadan-hero-heading"
          className="mt-6 font-serif text-4xl font-semibold leading-[1.05] text-sage-700 sm:text-5xl md:text-6xl"
        >
          {HEADING_WORDS.map((word, index) => (
            <motion.span
              key={`${word}-${index}`}
              {...wordReveal(index)}
              className="mx-2 inline-block"
            >
              {word}
            </motion.span>
          ))}
        </h1>

        {/* Subheading */}
        <motion.p
          {...fadeUp(1.0)}
          className="mt-8 max-w-2xl text-base leading-relaxed text-slate-600 sm:text-lg"
        >
          Your open-hearted contribution may make a difference in lives of
          millions of hungry people
        </motion.p>

        {/* CTAs */}
        <motion.div
          {...fadeUp(1.2)}
          className="mt-10 flex flex-wrap items-center justify-center gap-4"
        >
          <motion.a
            href="#annadan-tiers"
            whileHover={reduceMotion ? undefined : { y: -2, scale: 1.04 }}
            whileTap={reduceMotion ? undefined : { scale: 0.97 }}
            transition={{ type: "spring", stiffness: 300, damping: 20 }}
            style={{ perspective: "600px", transformStyle: "preserve-3d" }}
            className="inline-flex items-center gap-2 rounded-full bg-sage-600 px-6 py-3 text-sm font-semibold text-ivory-50 shadow-sm transition-colors hover:bg-sage-700"
          >
            DONATE NOW
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <line x1="5" y1="12" x2="19" y2="12" />
              <polyline points="12 5 19 12 12 19" />
            </svg>
          </motion.a>
          <motion.a
            href="#gauseva-tiers"
            whileHover={reduceMotion ? undefined : { y: -2, scale: 1.04 }}
            whileTap={reduceMotion ? undefined : { scale: 0.97 }}
            transition={{ type: "spring", stiffness: 300, damping: 20 }}
            style={{ perspective: "600px", transformStyle: "preserve-3d" }}
            className="inline-flex items-center gap-2 rounded-full border border-sage-600 px-6 py-3 text-sm font-semibold text-sage-700 transition-colors hover:bg-sage-50"
          >
            GAUSEVA
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <line x1="5" y1="12" x2="19" y2="12" />
              <polyline points="12 5 19 12 12 19" />
            </svg>
          </motion.a>
        </motion.div>

        {/* 80G banner */}
        <motion.p
          {...fadeUp(1.4)}
          className="mt-8 max-w-2xl text-[10px] uppercase leading-relaxed tracking-[0.2em] text-slate-500 sm:text-xs"
        >
          AVAIL 80G BENEFITS ON THE DONATIONS MADE TO ISKCON &middot; You Will
          Be Directed To A Secure Payment Gateway
        </motion.p>
      </div>
    </section>
  );
}
