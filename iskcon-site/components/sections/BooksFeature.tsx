"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import Reveal from "@/components/Reveal";

export default function BooksFeature() {
  const reduceMotion = useReducedMotion();

  return (
    <section
      aria-labelledby="books-feature-heading"
      className="relative w-full bg-ivory-50/40 px-4 py-20 sm:px-6 lg:px-8"
    >
      <div className="mx-auto grid max-w-6xl grid-cols-1 items-center gap-12 md:grid-cols-2">
        {/* Left column — book illustration with parallax shift */}
        <motion.div
          initial={reduceMotion ? { opacity: 0 } : { y: 30, opacity: 0 }}
          whileInView={
            reduceMotion ? { opacity: 1 } : { y: -30, opacity: 1 }
          }
          viewport={{ once: true, margin: "-100px" }}
          transition={
            reduceMotion
              ? { duration: 0.2 }
              : { type: "spring", stiffness: 80, damping: 18 }
          }
          className="mx-auto w-full max-w-md"
        >
          <div
            className="relative aspect-[3/4] overflow-hidden rounded-2xl border border-sage-100 bg-gradient-to-br from-sage-50 via-ivory-100 to-ivory-50 shadow-md"
            aria-hidden="true"
          >
            {/* Inline open-book illustration */}
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 240 320"
              className="absolute inset-0 h-full w-full p-8"
            >
              {/* Book base shadow */}
              <ellipse cx="120" cy="290" rx="90" ry="8" fill="#506b35" opacity="0.15" />

              {/* Left page */}
              <path
                d="M30 60 Q30 55 35 55 L115 55 Q120 55 120 60 L120 270 Q120 275 115 275 L35 275 Q30 275 30 270 Z"
                fill="#fdfaf3"
                stroke="#506b35"
                strokeWidth="2"
              />
              {/* Right page */}
              <path
                d="M120 60 Q120 55 125 55 L205 55 Q210 55 210 60 L210 270 Q210 275 205 275 L125 275 Q120 275 120 270 Z"
                fill="#fdfaf3"
                stroke="#506b35"
                strokeWidth="2"
              />
              {/* Center spine */}
              <line
                x1="120"
                y1="55"
                x2="120"
                y2="275"
                stroke="#506b35"
                strokeWidth="2"
              />

              {/* Left page lines (text) */}
              <line x1="45" y1="80" x2="105" y2="80" stroke="#506b35" strokeWidth="1.5" opacity="0.6" />
              <line x1="45" y1="92" x2="100" y2="92" stroke="#506b35" strokeWidth="1" opacity="0.4" />
              <line x1="45" y1="100" x2="105" y2="100" stroke="#506b35" strokeWidth="1" opacity="0.4" />
              <line x1="45" y1="108" x2="95" y2="108" stroke="#506b35" strokeWidth="1" opacity="0.4" />

              <line x1="45" y1="130" x2="105" y2="130" stroke="#506b35" strokeWidth="1.5" opacity="0.6" />
              <line x1="45" y1="142" x2="100" y2="142" stroke="#506b35" strokeWidth="1" opacity="0.4" />
              <line x1="45" y1="150" x2="105" y2="150" stroke="#506b35" strokeWidth="1" opacity="0.4" />
              <line x1="45" y1="158" x2="98" y2="158" stroke="#506b35" strokeWidth="1" opacity="0.4" />

              <line x1="45" y1="180" x2="105" y2="180" stroke="#506b35" strokeWidth="1.5" opacity="0.6" />
              <line x1="45" y1="192" x2="92" y2="192" stroke="#506b35" strokeWidth="1" opacity="0.4" />
              <line x1="45" y1="200" x2="105" y2="200" stroke="#506b35" strokeWidth="1" opacity="0.4" />
              <line x1="45" y1="208" x2="100" y2="208" stroke="#506b35" strokeWidth="1" opacity="0.4" />

              {/* Right page lines */}
              <line x1="135" y1="80" x2="195" y2="80" stroke="#506b35" strokeWidth="1.5" opacity="0.6" />
              <line x1="135" y1="92" x2="190" y2="92" stroke="#506b35" strokeWidth="1" opacity="0.4" />
              <line x1="135" y1="100" x2="195" y2="100" stroke="#506b35" strokeWidth="1" opacity="0.4" />
              <line x1="135" y1="108" x2="185" y2="108" stroke="#506b35" strokeWidth="1" opacity="0.4" />

              <line x1="135" y1="130" x2="195" y2="130" stroke="#506b35" strokeWidth="1.5" opacity="0.6" />
              <line x1="135" y1="142" x2="190" y2="142" stroke="#506b35" strokeWidth="1" opacity="0.4" />
              <line x1="135" y1="150" x2="195" y2="150" stroke="#506b35" strokeWidth="1" opacity="0.4" />
              <line x1="135" y1="158" x2="188" y2="158" stroke="#506b35" strokeWidth="1" opacity="0.4" />

              <line x1="135" y1="180" x2="195" y2="180" stroke="#506b35" strokeWidth="1.5" opacity="0.6" />
              <line x1="135" y1="192" x2="182" y2="192" stroke="#506b35" strokeWidth="1" opacity="0.4" />
              <line x1="135" y1="200" x2="195" y2="200" stroke="#506b35" strokeWidth="1" opacity="0.4" />
              <line x1="135" y1="208" x2="190" y2="208" stroke="#506b35" strokeWidth="1" opacity="0.4" />

              {/* Oil drop icon */}
              <path
                d="M120 35 Q115 30 115 25 Q115 20 120 18 Q125 20 125 25 Q125 30 120 35 Z"
                fill="#6b8a4a"
                opacity="0.7"
              />
              <text
                x="120"
                y="248"
                textAnchor="middle"
                fontSize="14"
                fill="#506b35"
                fontFamily="serif"
                fontStyle="italic"
              >
                The Oil Book
              </text>
              <line
                x1="60"
                y1="260"
                x2="180"
                y2="260"
                stroke="#506b35"
                strokeWidth="1"
                opacity="0.5"
              />
            </svg>
          </div>
        </motion.div>

        {/* Right column — copy + CTA */}
        <Reveal delay={0.15}>
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-sage-600">
              Featured Publication
            </p>
            <h2
              id="books-feature-heading"
              className="mt-4 font-serif text-3xl text-sage-700 sm:text-4xl"
            >
              The Oil Book
            </h2>
            <div className="mt-6 space-y-4 text-base leading-relaxed text-slate-600">
              <p>
                In a world full of adulterated fats and industrial seed oils,
                <em> The Oil Book</em> reclaims an ancient truth: pure, sanctified
                ghee is not just food, it is a cornerstone of body, mind, and
                spiritual well-being. Rooted in Vedic wisdom and validated by
                modern science, the book is a practical guide for the kitchen
                and the soul.
              </p>
              <p>
                Published by ISKCON Gurugram Sector 57, this concise volume answers
                the questions our community asks most often: which oils to use,
                how to identify pure ghee, and why Krishna prasadam nourishes in
                ways that ordinary food cannot. Order a copy for your family,
                your ashram, or your next study circle.
              </p>
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
                href="/nirjalaekadashi"
                className="rounded-full border border-sage-600 px-6 py-3 text-sm font-semibold text-sage-700 transition-colors hover:bg-sage-50"
              >
                Read more
              </Link>
            </motion.div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
