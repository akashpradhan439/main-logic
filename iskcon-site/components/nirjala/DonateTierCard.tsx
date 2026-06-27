"use client";

import { motion, useReducedMotion } from "framer-motion";
import Reveal from "@/components/Reveal";

interface DonateTierCardProps {
  title: string;
  amount: string;
  href: string;
  index: number;
  variant?: "default" | "featured";
  label?: string;
}

/**
 * Reusable donate tier card used by AnnadanSection and GausevaSection.
 *
 * - Reveal-wrapped for scroll entrance (stagger via `index`).
 * - 3D tilt on hover (respects useReducedMotion).
 * - "featured" variant renders a wider, dark-styled hero card.
 */
export default function DonateTierCard({
  title,
  amount,
  href,
  index,
  variant = "default",
  label,
}: DonateTierCardProps) {
  const reduceMotion = useReducedMotion();
  const isFeatured = variant === "featured";

  const cardClasses = isFeatured
    ? "relative h-full overflow-hidden rounded-3xl border border-sage-700 bg-gradient-to-br from-sage-700 via-sage-700 to-sage-600 p-8 text-center text-ivory-50 shadow-xl sm:p-10"
    : "flex h-full flex-col items-center justify-between rounded-2xl border border-sage-100 bg-white/80 p-6 text-center shadow-sm backdrop-blur-sm";

  const labelClasses = isFeatured
    ? "text-xs font-semibold uppercase tracking-[0.3em] text-ivory-50/80"
    : "text-xs font-semibold uppercase tracking-[0.2em] text-sage-600";

  const titleClasses = isFeatured
    ? "mt-3 font-serif text-2xl text-ivory-50 sm:text-3xl"
    : "mt-3 font-serif text-xl text-sage-700";

  const amountClasses = isFeatured
    ? "mt-4 font-sans text-3xl font-semibold text-ivory-50 sm:text-4xl"
    : "mt-4 font-sans text-2xl font-semibold text-sage-600";

  return (
    <Reveal delay={index * 0.08}>
      <motion.div
        whileHover={
          reduceMotion
            ? undefined
            : { y: -6, rotateX: 4, rotateY: -4, scale: 1.02 }
        }
        transition={{ type: "spring", stiffness: 250, damping: 20 }}
        style={{ perspective: "1000px", transformStyle: "preserve-3d" }}
        className="h-full"
      >
        <article className={cardClasses}>
          {isFeatured && (
            <span className="absolute right-4 top-4 inline-flex items-center gap-1 rounded-full bg-ivory-50/15 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-ivory-50 backdrop-blur-sm">
              Featured
            </span>
          )}
          {label && <p className={labelClasses}>{label}</p>}
          <h3 className={titleClasses}>{title}</h3>
          <p className={amountClasses}>{amount}</p>

          <motion.a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            whileHover={
              reduceMotion
                ? undefined
                : { scale: 1.06, boxShadow: "0 12px 30px rgba(80, 107, 53, 0.45)" }
            }
            whileTap={reduceMotion ? undefined : { scale: 0.96 }}
            transition={{ type: "spring", stiffness: 300, damping: 20 }}
            className={
              isFeatured
                ? "mt-6 inline-flex items-center gap-2 rounded-full bg-ivory-50 px-6 py-3 font-semibold text-sage-700 shadow-sm transition-colors hover:bg-ivory-100"
                : "mt-6 inline-flex items-center gap-2 rounded-full bg-sage-600 px-6 py-3 font-semibold text-ivory-50 shadow-sm transition-colors hover:bg-sage-700"
            }
            aria-label={`Donate ${amount} for ${title}`}
          >
            Donate
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M12 21s-7-4.5-9.5-9A5.5 5.5 0 0 1 12 5a5.5 5.5 0 0 1 9.5 7c-2.5 4.5-9.5 9-9.5 9z" />
            </svg>
          </motion.a>
        </article>
      </motion.div>
    </Reveal>
  );
}
