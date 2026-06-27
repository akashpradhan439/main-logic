"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import Reveal from "@/components/Reveal";

export default function SoulMelodies() {
  const reduceMotion = useReducedMotion();

  return (
    <section
      aria-labelledby="soul-melodies-heading"
      className="relative w-full px-4 py-20 sm:px-6 lg:px-8"
    >
      <div className="mx-auto max-w-6xl">
        <Reveal className="text-center">
          <h2
            id="soul-melodies-heading"
            className="font-serif text-3xl text-sage-700 sm:text-4xl"
          >
            Soul Melodies
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-base text-slate-600">
            Sacred kirtan, mantra meditation, and devotional music from the
            heart
          </p>
        </Reveal>

        <Reveal delay={0.15}>
          <div className="mx-auto mt-12 flex max-w-3xl flex-col items-center">
            {/* Vinyl disc illustration */}
            <div
              className="relative aspect-[21/9] w-full overflow-hidden rounded-2xl border border-sage-100 bg-gradient-to-br from-sage-50 via-ivory-100 to-sage-50 shadow-md"
              aria-hidden="true"
            >
              <div className="absolute inset-0 flex items-center justify-center">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 240 240"
                  className="h-32 w-32 text-sage-700"
                >
                  {/* Outer disc */}
                  <circle cx="120" cy="120" r="110" fill="#1a1a1a" />
                  <circle
                    cx="120"
                    cy="120"
                    r="110"
                    fill="none"
                    stroke="#506b35"
                    strokeWidth="2"
                    opacity="0.4"
                  />
                  {/* Grooves */}
                  {[90, 78, 66, 54, 42].map((r) => (
                    <circle
                      key={r}
                      cx="120"
                      cy="120"
                      r={r}
                      fill="none"
                      stroke="#506b35"
                      strokeWidth="0.5"
                      opacity="0.3"
                    />
                  ))}
                  {/* Center label */}
                  <circle cx="120" cy="120" r="36" fill="#fdfaf3" />
                  <circle
                    cx="120"
                    cy="120"
                    r="36"
                    fill="none"
                    stroke="#506b35"
                    strokeWidth="1"
                  />
                  {/* Center hole */}
                  <circle cx="120" cy="120" r="4" fill="#1a1a1a" />
                  {/* Label text */}
                  <text
                    x="120"
                    y="115"
                    textAnchor="middle"
                    fontSize="10"
                    fill="#506b35"
                    fontFamily="serif"
                    fontWeight="600"
                  >
                    Hare
                  </text>
                  <text
                    x="120"
                    y="130"
                    textAnchor="middle"
                    fontSize="10"
                    fill="#506b35"
                    fontFamily="serif"
                    fontWeight="600"
                  >
                    Krishna
                  </text>
                </svg>
              </div>

              {/* Subtle shimmer overlay */}
              <div
                className="pointer-events-none absolute inset-0"
                style={{
                  background:
                    "linear-gradient(115deg, transparent 30%, rgba(255,255,255,0.18) 50%, transparent 70%)",
                }}
              />
            </div>

            <motion.div
              whileHover={
                reduceMotion ? undefined : { scale: 1.05, rotateX: 6 }
              }
              whileTap={reduceMotion ? undefined : { scale: 0.97 }}
              transition={{ type: "spring", stiffness: 300, damping: 20 }}
              style={{ perspective: "600px", transformStyle: "preserve-3d" }}
              className="mt-8 inline-flex"
            >
              <Link
                href="https://www.youtube.com/@iskconsecunderabad"
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-full border border-sage-600 px-6 py-3 text-sm font-semibold text-sage-700 transition-colors hover:bg-sage-50"
              >
                Listen on YouTube
              </Link>
            </motion.div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
