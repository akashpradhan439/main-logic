"use client";

import Image from "next/image";
import { motion, useReducedMotion } from "framer-motion";
import Reveal from "@/components/Reveal";

const VIDEO_URL =
  "https://www.youtube.com/results?search_query=iskcon+food+for+life+modi";
const THUMBNAIL_URL =
  "https://static.wixstatic.com/media/17ad63_54bdec1032e34bbebb8ff6f506b9d817f002.jpg";

export default function ModiVideo() {
  const reduceMotion = useReducedMotion();

  return (
    <section
      aria-labelledby="modi-video-heading"
      className="bg-gradient-to-b from-sage-50 to-ivory-50 px-4 py-16 sm:py-20 sm:px-6 lg:px-8"
    >
      <div className="mx-auto max-w-5xl text-center">
        <Reveal>
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-sage-600 sm:text-sm">
            ISKCON initiative of Food for Life &mdash; AnnaDaan
          </p>
          <h2
            id="modi-video-heading"
            className="mt-4 font-serif text-3xl text-sage-700 sm:text-4xl"
          >
            Appreciated by Shri Narendra Modi ji, The Prime Minister of India
          </h2>
        </Reveal>

        <Reveal delay={0.15}>
          <motion.a
            href={VIDEO_URL}
            target="_blank"
            rel="noopener noreferrer"
            whileHover={reduceMotion ? undefined : { y: -4, scale: 1.01 }}
            transition={{ type: "spring", stiffness: 250, damping: 20 }}
            style={{ perspective: "1000px", transformStyle: "preserve-3d" }}
            className="group relative mx-auto mt-10 block aspect-video w-full max-w-3xl overflow-hidden rounded-2xl shadow-2xl"
            aria-label="Watch PM Modi appreciating ISKCON Food for Life on YouTube"
          >
            <Image
              src={THUMBNAIL_URL}
              alt="PM Modi appreciating ISKCON Food for Life"
              width={1798}
              height={1011}
              className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
            />
            {/* Dim overlay */}
            <div
              aria-hidden="true"
              className="absolute inset-0 bg-black/25 transition-colors group-hover:bg-black/15"
            />
            {/* Play button */}
            <motion.div
              initial={false}
              animate={reduceMotion ? { scale: 1 } : { scale: [1, 1.08, 1] }}
              transition={{
                duration: 2,
                repeat: Infinity,
                repeatType: "mirror",
                ease: "easeInOut",
              }}
              className="absolute inset-0 flex items-center justify-center"
              aria-hidden="true"
            >
              <span className="flex h-20 w-20 items-center justify-center rounded-full bg-white/90 text-sage-700 shadow-2xl backdrop-blur-sm transition-colors group-hover:bg-white sm:h-24 sm:w-24">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="32"
                  height="32"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  aria-hidden="true"
                  className="ml-1"
                >
                  <polygon points="6 4 20 12 6 20 6 4" />
                </svg>
              </span>
            </motion.div>
            <span className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-black/50 px-4 py-1.5 text-xs font-semibold uppercase tracking-[0.2em] text-white backdrop-blur-sm">
              Watch on YouTube
            </span>
          </motion.a>
        </Reveal>
      </div>
    </section>
  );
}
