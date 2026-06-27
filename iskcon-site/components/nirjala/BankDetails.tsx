"use client";

import { motion, useReducedMotion } from "framer-motion";
import Reveal from "@/components/Reveal";

interface BankRow {
  label: string;
  value: string;
  mono?: boolean;
}

const BANK_DETAILS: BankRow[] = [
  { label: "Account Name", value: "International Society for Krishna Consciousnes" },
  { label: "Account Number", value: "193601000716", mono: true },
  { label: "Bank", value: "ICICI Bank" },
  { label: "IFSC", value: "ICIC0001936", mono: true },
  { label: "Branch", value: "West Marredpally" },
];

export default function BankDetails() {
  const reduceMotion = useReducedMotion();

  return (
    <section
      aria-labelledby="bank-details-heading"
      className="px-4 py-16 sm:px-6 lg:px-8"
    >
      <div className="mx-auto max-w-4xl">
        <Reveal className="text-center">
          <h2
            id="bank-details-heading"
            className="font-serif text-3xl text-sage-700 sm:text-4xl"
          >
            Donation Through Bank (NEFT/RTGS)
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-base text-slate-600">
            Prefer a direct bank transfer? Use the details below to donate via
            NEFT, RTGS, or IMPS from any bank in India.
          </p>
        </Reveal>

        <Reveal delay={0.1}>
          <div className="mt-10 overflow-hidden rounded-2xl border border-sage-100 bg-white/80 shadow-lg backdrop-blur-sm">
            <dl className="divide-y divide-sage-100">
              {BANK_DETAILS.map((row) => (
                <div
                  key={row.label}
                  className="flex flex-col gap-1 px-6 py-5 sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:px-10 sm:py-6"
                >
                  <dt className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500 sm:text-sm">
                    {row.label}
                  </dt>
                  <dd
                    className={`text-base text-sage-700 sm:text-lg font-medium ${
                      row.mono ? "font-mono tabular-nums" : "font-sans"
                    }`}
                  >
                    {row.value}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </Reveal>

        {/* 80G exemption card */}
        <Reveal delay={0.2}>
          <div className="mt-8 rounded-xl border border-sage-100 bg-ivory-50 p-6 sm:p-8">
            <h3 className="text-xs font-semibold uppercase tracking-[0.2em] text-sage-700">
              80G Exemption
            </h3>
            <p className="mt-3 text-sm leading-relaxed text-slate-600">
              Exemption Certificate Ref. No.:&nbsp;
              <span className="font-medium text-sage-700">
                आ. नि. (छू.) मु. न./80-जी/1667/2007/2008-2009
              </span>
              . Validity extended perpetually vide CBDT Circular No.&nbsp;7/2010
              dated 27/10/2010.
            </p>
          </div>
        </Reveal>

        {/* Contact CTA */}
        <Reveal delay={0.3}>
          <div className="mt-12 text-center">
            <h3 className="font-serif text-2xl text-sage-700 sm:text-3xl">
              Need help in donation or have a query?
            </h3>
            <p className="mx-auto mt-3 max-w-xl text-base text-slate-600">
              Our team is available 10:00 am to 5:00 PM everyday except on
              Sunday and festivals. We&apos;re happy to help with bulk
              contributions, tax receipts, or any other questions.
            </p>
            <motion.a
              href="mailto:support@iskconsecunderabad.com"
              whileHover={reduceMotion ? undefined : { scale: 1.04 }}
              whileTap={reduceMotion ? undefined : { scale: 0.97 }}
              transition={{ type: "spring", stiffness: 300, damping: 20 }}
              className="mt-6 inline-flex items-center gap-2 rounded-full bg-sage-600 px-6 py-3 text-sm font-semibold text-ivory-50 shadow-sm transition-colors hover:bg-sage-700"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                <polyline points="22,6 12,13 2,6" />
              </svg>
              Send a Mail
            </motion.a>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
