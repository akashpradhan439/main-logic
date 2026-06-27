"use client";

import Reveal from "@/components/Reveal";
import DonateTierCard from "./DonateTierCard";

interface Tier {
  title: string;
  amount: string;
  href: string;
}

const TIERS: Tier[] = [
  {
    title: "Feed 10 cows for a day",
    amount: "Rs. 2,400",
    href: "https://payments.cashfree.com/forms/10COWSPERDAYFEEDING",
  },
  {
    title: "Medicines for cow",
    amount: "Rs. 2,500",
    href: "https://payments.cashfree.com/forms/ISKCONMEDICINESFORCOW",
  },
  {
    title: "Feed a cow for a month",
    amount: "Rs. 3,500",
    href: "https://payments.cashfree.com/forms/ISKCONFEEDACOWFORAMONTH",
  },
  {
    title: "Feed 5 cows for a week",
    amount: "Rs. 5,000",
    href: "https://payments.cashfree.com/forms/ISKCONFEED5COWSFORAWEEK",
  },
  {
    title: "Green grass for all cows for a day",
    amount: "Rs. 9,000",
    href: "https://payments.cashfree.com/forms/ISKCONGREENGRASSFORALLCOWS",
  },
  {
    title: "Fodder for all cows for a day",
    amount: "Rs. 15,000",
    href: "https://payments.cashfree.com/forms/ISKCONFOODERFORALLCOWSFORADAY",
  },
  {
    title: "Adopt a cow for an year",
    amount: "Rs. 40,000",
    href: "https://payments.cashfree.com/forms/ISKCONADOPT3COWSFORANYEAR",
  },
  {
    title: "Adopt 3 cows for an year",
    amount: "Rs. 1,20,000",
    href: "https://payments.cashfree.com/forms/ISKCONADOPT3COWSFORANYEAR",
  },
  {
    title: "Adopt 5 cows for an year",
    amount: "Rs. 2,00,000",
    href: "https://payments.cashfree.com/forms/ISKCONADOPT3COWSFORANYEAR",
  },
  {
    title: "Donate any other amount",
    amount: "Custom",
    href: "https://payments.cashfree.com/forms/DonateAnyOtherAmountforCOW",
  },
];

export default function GausevaSection() {
  return (
    <section
      id="gauseva-tiers"
      aria-labelledby="gauseva-section-heading"
      className="scroll-mt-24 bg-gradient-to-b from-sage-50 via-ivory-50 to-ivory-100 px-4 py-16 sm:px-6 lg:px-8"
    >
      <div className="mx-auto max-w-6xl">
        <Reveal className="text-center">
          <h2
            id="gauseva-section-heading"
            className="font-serif text-3xl text-sage-700 sm:text-4xl"
          >
            Gauseva
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-base text-slate-600">
            Gau Seva is an integral aspect of our Vedic heritage and culture.
            In our country, cows are not only protected but also revered and
            worshipped. Our Vedic scriptures state that all the devatas reside
            in a cow&apos;s body. Hence, the cow is considered to be divine and
            regarded as a mother. Your donations will help us continue our Gau
            Raksha program.
          </p>
        </Reveal>

        {/* Sanskrit shloka block */}
        <Reveal delay={0.15}>
          <blockquote className="mx-auto mt-12 max-w-3xl rounded-2xl bg-ivory-100 p-8 text-center shadow-sm sm:p-12">
            <p className="font-serif text-xl italic leading-relaxed text-sage-700 sm:text-2xl">
              rinodakadi samyuktham yah pradadyat gavahnikam
              <br />
              so asvamedha samam punyam
            </p>
            <footer className="mt-6 text-sm text-slate-500">
              &mdash; Brihat Parashara Smriti (5.26-27)
            </footer>
          </blockquote>
        </Reveal>

        {/* Tier grid */}
        <div className="mt-12 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {TIERS.map((tier, index) => (
            <DonateTierCard
              key={tier.title}
              index={index}
              title={tier.title}
              amount={tier.amount}
              href={tier.href}
              label="Gauseva Tier"
            />
          ))}
        </div>
      </div>
    </section>
  );
}
