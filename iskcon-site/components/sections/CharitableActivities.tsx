"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import Reveal from "@/components/Reveal";

interface Activity {
  title: string;
  body: string;
  href: string;
  icon: React.ReactNode;
}

const ACTIVITIES: Activity[] = [
  {
    title: "Annadanam",
    body:
      "Free prasadam distribution to thousands daily. Food is offered to Krishna and served with love.",
    href: "/annadanam",
    icon: (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 64 64"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-16 w-16 text-sage-600"
        aria-hidden="true"
      >
        {/* Plate */}
        <ellipse cx="32" cy="42" rx="22" ry="6" fill="currentColor" opacity="0.15" />
        <ellipse cx="32" cy="40" rx="22" ry="6" />
        {/* Bowl */}
        <path d="M18 40 Q18 28 32 28 Q46 28 46 40" />
        {/* Steam */}
        <path d="M26 22 Q26 18 28 16 Q30 14 28 12" opacity="0.6" />
        <path d="M32 22 Q32 18 34 16 Q36 14 34 12" opacity="0.6" />
        <path d="M38 22 Q38 18 40 16 Q42 14 40 12" opacity="0.6" />
        {/* Laddoo dots */}
        <circle cx="26" cy="36" r="2" fill="currentColor" />
        <circle cx="32" cy="34" r="2" fill="currentColor" />
        <circle cx="38" cy="36" r="2" fill="currentColor" />
      </svg>
    ),
  },
  {
    title: "Education & Gita Classes",
    body:
      "Vedic wisdom for the modern age. Sunday school, youth programs, and Bhagavad-gita classes for all ages.",
    href: "/personal",
    icon: (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 64 64"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-16 w-16 text-sage-600"
        aria-hidden="true"
      >
        {/* Open book */}
        <path d="M8 18 L32 22 L32 50 L8 46 Z" fill="currentColor" opacity="0.08" />
        <path d="M32 22 L56 18 L56 46 L32 50 Z" fill="currentColor" opacity="0.08" />
        <path d="M8 18 L32 22 L32 50 L8 46 Z" />
        <path d="M32 22 L56 18 L56 46 L32 50 Z" />
        <line x1="32" y1="22" x2="32" y2="50" />
        {/* Lines */}
        <line x1="14" y1="26" x2="26" y2="28" opacity="0.5" />
        <line x1="14" y1="32" x2="26" y2="34" opacity="0.5" />
        <line x1="14" y1="38" x2="26" y2="40" opacity="0.5" />
        <line x1="38" y1="28" x2="50" y2="26" opacity="0.5" />
        <line x1="38" y1="34" x2="50" y2="32" opacity="0.5" />
        <line x1="38" y1="40" x2="50" y2="38" opacity="0.5" />
        {/* Om mark */}
        <text
          x="32"
          y="14"
          textAnchor="middle"
          fontSize="10"
          fill="currentColor"
          stroke="none"
          fontFamily="serif"
        >
          Om
        </text>
      </svg>
    ),
  },
  {
    title: "Goshala",
    body:
      "Protecting cows, the sacred mothers. Our goshala shelters over 40 cows and bulls with daily Vedic care.",
    href: "/cow-research",
    icon: (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 64 64"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-16 w-16 text-sage-600"
        aria-hidden="true"
      >
        {/* Body */}
        <ellipse cx="32" cy="36" rx="18" ry="11" fill="currentColor" opacity="0.08" />
        <ellipse cx="32" cy="36" rx="18" ry="11" />
        {/* Head */}
        <ellipse cx="14" cy="30" rx="6" ry="7" fill="currentColor" opacity="0.08" />
        <ellipse cx="14" cy="30" rx="6" ry="7" />
        {/* Horns */}
        <path d="M11 24 Q9 20 7 21" />
        <path d="M17 24 Q19 20 21 21" />
        {/* Eye */}
        <circle cx="12" cy="29" r="0.8" fill="currentColor" />
        {/* Snout */}
        <ellipse cx="10" cy="33" rx="2" ry="1.5" />
        {/* Legs */}
        <line x1="22" y1="46" x2="22" y2="54" />
        <line x1="30" y1="47" x2="30" y2="54" />
        <line x1="38" y1="47" x2="38" y2="54" />
        <line x1="46" y1="46" x2="46" y2="54" />
        {/* Tail */}
        <path d="M50 32 Q54 30 54 26" />
        <path d="M54 26 Q57 27 56 30" />
        {/* Spot */}
        <circle cx="36" cy="34" r="2" fill="currentColor" opacity="0.4" />
      </svg>
    ),
  },
];

export default function CharitableActivities() {
  const reduceMotion = useReducedMotion();

  return (
    <section
      aria-labelledby="charitable-activities-heading"
      className="relative w-full px-4 py-20 sm:px-6 lg:px-8"
    >
      <div className="mx-auto max-w-6xl">
        <Reveal className="text-center">
          <h2
            id="charitable-activities-heading"
            className="font-serif text-3xl text-sage-700 sm:text-4xl"
          >
            Charitable &amp; Social Activities
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-base text-slate-600">
            Service to humanity is service to Krishna
          </p>
        </Reveal>

        <div className="mt-12 grid grid-cols-1 gap-6 md:grid-cols-3 sm:gap-8">
          {ACTIVITIES.map((activity, index) => (
            <Reveal key={activity.title} delay={index * 0.1}>
              <motion.div
                whileHover={
                  reduceMotion
                    ? undefined
                    : { y: -8, rotateX: 4, rotateY: -4, scale: 1.02 }
                }
                transition={{ type: "spring", stiffness: 250, damping: 20 }}
                style={{ perspective: "1000px", transformStyle: "preserve-3d" }}
                className="h-full"
              >
                <article className="flex h-full flex-col overflow-hidden rounded-2xl border border-sage-100 bg-white/70 shadow-sm backdrop-blur-sm transition-shadow hover:shadow-xl">
                  {/* Icon / image area */}
                  <div className="relative aspect-[4/3] flex items-center justify-center bg-gradient-to-br from-sage-50 via-ivory-100 to-sage-50">
                    {activity.icon}
                  </div>

                  {/* Body */}
                  <div className="flex flex-1 flex-col p-6">
                    <h3 className="font-serif text-xl text-sage-700">
                      {activity.title}
                    </h3>
                    <p className="mt-3 flex-1 text-sm leading-relaxed text-slate-600">
                      {activity.body}
                    </p>
                    <Link
                      href={activity.href}
                      className="mt-5 inline-flex items-center gap-1 text-sm font-semibold text-sage-700 transition-colors hover:text-sage-600"
                    >
                      Learn more
                      <span aria-hidden="true" className="transition-transform group-hover:translate-x-1">
                        &rarr;
                      </span>
                    </Link>
                  </div>
                </article>
              </motion.div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
