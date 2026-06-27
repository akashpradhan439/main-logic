"use client";

import Reveal from "@/components/Reveal";

interface LectureCard {
  title: string;
  speaker: string;
}

const LECTURE_CARDS: LectureCard[] = [
  { title: "The Inner Journey", speaker: "HH Bhakti Vijnana Goswami" },
  { title: "Karma & Free Will", speaker: "HG Madhu Pandit Dasa" },
  { title: "Bhakti in Daily Life", speaker: "HG Chanchalapathi Dasa" },
];

// Inline decorative audio-waveform SVG
function WaveformIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 80 32"
      className={className}
      aria-hidden="true"
    >
      {[6, 12, 18, 24, 14, 22, 10, 26, 8, 20, 16, 28, 12, 18, 6, 14, 22, 10, 24, 16].map(
        (h, i) => (
          <rect
            key={i}
            x={i * 4}
            y={(32 - h) / 2}
            width="2"
            height={h}
            rx="1"
            fill="currentColor"
            opacity={0.6 + (i % 5) * 0.08}
          />
        ),
      )}
    </svg>
  );
}

export default function LecturesSection() {
  return (
    <section
      aria-labelledby="lectures-heading"
      className="relative w-full px-4 py-20 sm:px-6 lg:px-8"
    >
      <div className="mx-auto max-w-6xl">
        <Reveal className="text-center">
          <h2
            id="lectures-heading"
            className="font-serif text-3xl text-sage-700 sm:text-4xl"
          >
            Spiritual Lectures
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-base text-slate-600">
            Wisdom from realized teachers. New recordings every week.
          </p>
        </Reveal>

        <div className="mt-12 grid grid-cols-1 gap-6 md:grid-cols-3">
          {LECTURE_CARDS.map((card, index) => (
            <Reveal key={card.title} delay={index * 0.1}>
              <article className="flex h-full flex-col rounded-2xl border border-sage-100 bg-ivory-50 p-6 shadow-sm">
                <WaveformIcon className="h-8 w-20 text-sage-600" />
                <h3 className="mt-6 font-serif text-xl text-sage-700">
                  {card.title}
                </h3>
                <p className="mt-2 text-sm text-slate-700">{card.speaker}</p>
                <p className="mt-auto pt-4 text-sm italic text-slate-500">
                  Coming soon
                </p>
              </article>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
