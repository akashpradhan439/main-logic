"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";

interface ComingSoonProps {
  title: string;
  subtext?: string;
}

const HEADING_WORDS = ["Coming", "soon"] as const;

export default function ComingSoon({ title, subtext }: ComingSoonProps) {
  const reduceMotion = useReducedMotion();

  // Pre-compute animation variants. When the user prefers reduced motion we
  // collapse to a simple fade so nothing bounces or drifts on the screen.
  const wordReveal = (index: number) => ({
    initial: reduceMotion ? { opacity: 0 } : { opacity: 0, y: 24 },
    animate: { opacity: 1, y: 0 },
    transition: {
      duration: reduceMotion ? 0.2 : 0.55,
      delay: 0.1 + index * 0.15,
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
      aria-labelledby="coming-soon-heading"
      className="relative isolate overflow-hidden"
    >
      {/* Decorative drifting blobs (purely visual) */}
      <div className="pointer-events-none absolute inset-0 -z-10" aria-hidden="true">
        <motion.div
          initial={false}
          animate={
            reduceMotion
              ? { x: 0, y: 0 }
              : { x: [0, 40, -20, 0], y: [0, -30, 20, 0] }
          }
          transition={{
            duration: 22,
            repeat: Infinity,
            repeatType: "mirror",
            ease: "easeInOut",
          }}
          className="absolute -left-24 -top-16 h-72 w-72 rounded-full bg-sage-100 opacity-60 blur-3xl sm:h-96 sm:w-96"
        />
        <motion.div
          initial={false}
          animate={
            reduceMotion
              ? { x: 0, y: 0 }
              : { x: [0, -30, 30, 0], y: [0, 40, -10, 0] }
          }
          transition={{
            duration: 26,
            repeat: Infinity,
            repeatType: "mirror",
            ease: "easeInOut",
          }}
          className="absolute -right-24 top-1/3 h-80 w-80 rounded-full bg-ivory-100 opacity-80 blur-3xl sm:h-[28rem] sm:w-[28rem]"
        />
        <motion.div
          initial={false}
          animate={
            reduceMotion
              ? { x: 0, y: 0 }
              : { x: [0, 20, -30, 0], y: [0, -20, 30, 0] }
          }
          transition={{
            duration: 20,
            repeat: Infinity,
            repeatType: "mirror",
            ease: "easeInOut",
          }}
          className="absolute -bottom-24 left-1/3 h-72 w-72 rounded-full bg-sage-100 opacity-50 blur-3xl sm:h-96 sm:w-96"
        />
      </div>

      <div className="mx-auto flex min-h-[calc(100vh-8rem)] max-w-3xl flex-col items-center justify-center px-4 py-20 text-center sm:px-6">
        {/* Title eyebrow (e.g. "Annadanam") */}
        <motion.p
          {...fadeUp(0)}
          className="text-xs font-semibold uppercase tracking-[0.3em] text-sage-600 sm:text-sm"
        >
          {title}
        </motion.p>

        {/* Main heading — staggered per word */}
        <h1
          id="coming-soon-heading"
          className="mt-5 font-serif text-5xl font-semibold leading-[1.05] text-sage-700 sm:text-6xl md:text-7xl"
        >
          {HEADING_WORDS.map((word, index) => (
            <motion.span
              key={word}
              {...wordReveal(index)}
              className="mx-2 inline-block"
            >
              {word}
            </motion.span>
          ))}
        </h1>

        {/* Optional subtext */}
        {subtext && (
          <motion.p
            {...fadeUp(0.55)}
            className="mt-8 max-w-xl text-base leading-relaxed text-slate-600 sm:text-lg"
          >
            {subtext}
          </motion.p>
        )}

        {/* CTA buttons */}
        <motion.div
          {...fadeUp(0.75)}
          className="mt-10 flex flex-wrap items-center justify-center gap-4"
        >
          <motion.button
            type="button"
            whileHover={
              reduceMotion ? undefined : { scale: 1.05, rotateX: 6 }
            }
            whileTap={reduceMotion ? undefined : { scale: 0.97 }}
            transition={{ type: "spring", stiffness: 300, damping: 20 }}
            style={{ perspective: "600px", transformStyle: "preserve-3d" }}
            className="inline-flex"
          >
            <Link
              href="/"
              className="rounded-full border border-sage-600 px-6 py-3 text-sm font-semibold text-sage-700 transition-colors hover:bg-sage-50"
            >
              Back to Home
            </Link>
          </motion.button>

          <motion.button
            type="button"
            whileHover={
              reduceMotion ? undefined : { scale: 1.05, rotateX: 6 }
            }
            whileTap={reduceMotion ? undefined : { scale: 0.97 }}
            transition={{ type: "spring", stiffness: 300, damping: 20 }}
            style={{ perspective: "600px", transformStyle: "preserve-3d" }}
            className="inline-flex"
          >
            <Link
              href="/nirjalaekadashi"
              className="rounded-full bg-sage-600 px-6 py-3 text-sm font-semibold text-ivory-50 shadow-sm transition-colors hover:bg-sage-700"
            >
              View Nirjala Ekadashi
            </Link>
          </motion.button>
        </motion.div>
      </div>
    </section>
  );
}
