"use client";

import Reveal from "@/components/Reveal";
import DonateTierCard from "./DonateTierCard";

interface Tier {
  title: string;
  amount: string;
  href: string;
}

const HERO_TIER: Tier = {
  title: "Annadan & Gauseva Combined",
  amount: "Rs. 2,700",
  href: "https://payments.cashfree.com/forms/AnnadaanGauseva",
};

const TIERS: Tier[] = [
  {
    title: "Feed 50 people",
    amount: "Rs. 1,500",
    href: "https://payments.cashfree.com/forms/donatefor50people",
  },
  {
    title: "Feed 100 people",
    amount: "Rs. 3,000",
    href: "https://payments.cashfree.com/forms/DonateFor100People",
  },
  {
    title: "Feed 200 people",
    amount: "Rs. 6,000",
    href: "https://payments.cashfree.com/forms/DonateFor200People",
  },
  {
    title: "Feed 300 people",
    amount: "Rs. 9,000",
    href: "https://payments.cashfree.com/forms/DonateFor300People",
  },
  {
    title: "Feed 400 people",
    amount: "Rs. 12,000",
    href: "https://payments.cashfree.com/forms/DonateFor400People",
  },
  {
    title: "Feed 500 people",
    amount: "Rs. 15,000",
    href: "https://payments.cashfree.com/forms/DonateFor500People",
  },
  {
    title: "Feed 1000 people",
    amount: "Rs. 30,000",
    href: "https://payments.cashfree.com/forms/DonateFor1000People",
  },
  {
    title: "Feed 2000 people",
    amount: "Rs. 55,555",
    href: "https://payments.cashfree.com/forms/DonateFor2000People",
  },
  {
    title: "Feed 3000 people",
    amount: "Rs. 1,08,000",
    href: "https://payments.cashfree.com/forms/DonateFor3000People",
  },
  {
    title: "Feed 6000 people",
    amount: "Rs. 2,00,000",
    href: "https://payments.cashfree.com/forms/DonateFor6000People",
  },
  {
    title: "Feed 10,000 people",
    amount: "Rs. 3,00,000",
    href: "https://payments.cashfree.com/forms/DonateFor10000People",
  },
  {
    title: "Donate Any Other Amount",
    amount: "Custom",
    href: "https://payments.cashfree.com/forms/DonateAny1Amount",
  },
];

export default function AnnadanSection() {
  return (
    <section
      id="annadan-tiers"
      aria-labelledby="annadan-section-heading"
      className="scroll-mt-24 px-4 py-16 sm:px-6 lg:px-8"
    >
      <div className="mx-auto max-w-6xl">
        <Reveal className="text-center">
          <h2
            id="annadan-section-heading"
            className="font-serif text-3xl text-sage-700 sm:text-4xl"
          >
            Annadan
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-base text-slate-600">
            Sponsor a meal offering and feed the hungry. Each contribution
            directly funds ISKCON Secunderabad&apos;s Annadan program.
          </p>
        </Reveal>

        {/* Featured hero tier */}
        <div className="mt-12">
          <DonateTierCard
            index={0}
            title={HERO_TIER.title}
            amount={HERO_TIER.amount}
            href={HERO_TIER.href}
            variant="featured"
            label="Annadan Tier"
          />
        </div>

        {/* Tier grid */}
        <div className="mt-10 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {TIERS.map((tier, index) => (
            <DonateTierCard
              key={tier.title}
              index={index + 1}
              title={tier.title}
              amount={tier.amount}
              href={tier.href}
              label="Annadan Tier"
            />
          ))}
        </div>
      </div>
    </section>
  );
}
