"use client";

import Reveal from "@/components/Reveal";

export default function CovidStrip() {
  return (
    <section
      aria-labelledby="covid-strip-heading"
      className="w-full border-y border-sage-100 bg-ivory-100 px-4 py-12 sm:px-6 lg:px-8"
    >
      <Reveal className="mx-auto max-w-3xl text-center">
        <div className="flex flex-col items-center justify-center gap-3 sm:flex-row sm:gap-4">
          {/* Heart + hands icon */}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 48 48"
            className="h-10 w-10 shrink-0 text-sage-600"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            {/* Cradling hands */}
            <path d="M8 32 Q12 28 18 30 L20 32" />
            <path d="M40 32 Q36 28 30 30 L28 32" />
            <path d="M14 36 Q24 42 34 36" />
            {/* Heart */}
            <path
              d="M24 24 Q20 18 16 20 Q12 22 14 28 Q16 32 24 36 Q32 32 34 28 Q36 22 32 20 Q28 18 24 24 Z"
              fill="currentColor"
              opacity="0.2"
            />
            <path d="M24 24 Q20 18 16 20 Q12 22 14 28 Q16 32 24 36 Q32 32 34 28 Q36 22 32 20 Q28 18 24 24 Z" />
          </svg>

          <div>
            <h2
              id="covid-strip-heading"
              className="font-serif text-2xl text-sage-700 sm:text-3xl"
            >
              Together, With Care
            </h2>
          </div>
        </div>

        <p className="mx-auto mt-4 max-w-2xl text-base text-slate-600">
          ISKCON Secunderabad continues to serve the community with safety and
          devotion. The temple is open with care protocols, and prasadam
          distribution continues for those in need.
        </p>
      </Reveal>
    </section>
  );
}
