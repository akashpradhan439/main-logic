"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import Reveal from "@/components/Reveal";

export default function DonateCTA() {
  const reduceMotion = useReducedMotion();

  return (
    <section
      aria-labelledby="donate-cta-heading"
      className="relative w-full overflow-hidden px-4 py-20 sm:px-6 lg:px-8"
    >
      {/* Gradient base */}
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-10 bg-gradient-to-br from-sage-50 via-ivory-100 to-sage-50"
      />
      {/* Decorative blurred blob */}
      <div
        aria-hidden="true"
        className="absolute left-1/2 top-1/2 -z-10 h-96 w-96 -translate-x-1/2 -translate-y-1/2 rounded-full bg-sage-100 opacity-40 blur-3xl"
      />

      <Reveal className="mx-auto max-w-3xl text-center">
        <h2
          id="donate-cta-heading"
          className="font-serif text-3xl text-sage-700 sm:text-5xl"
        >
          We Need Your Support
        </h2>
        <p className="mx-auto mt-6 max-w-2xl text-base text-slate-600 sm:text-lg">
          Your generosity sustains the temple, feeds the hungry, protects the
          cows, and shares the timeless wisdom of the Bhagavad-gita with
          seekers around the world.
        </p>

        <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
          <motion.div
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
              Donate Now
            </Link>
          </motion.div>

          <motion.div
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
              className="rounded-full border border-sage-600 px-6 py-3 text-sm font-semibold text-sage-700 transition-colors hover:bg-sage-50"
            >
              Explore Nirjala Ekadashi
            </Link>
          </motion.div>
        </div>
      </Reveal>
    </section>
  );
}
