import Link from "next/link";

const NAV_LINKS = [
  { href: "/", label: "Home" },
  { href: "/nirjalaekadashi", label: "Nirjala Ekadashi" },
  { href: "/annadanam", label: "Annadanam" },
  { href: "/personal", label: "Personal" },
  { href: "/cow-research", label: "Cow Research" },
  { href: "/donate", label: "Donate" },
];

export default function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer className="mt-16 border-t border-sage-100 bg-ivory-50 text-slate-800">
      <div className="mx-auto grid max-w-7xl grid-cols-1 gap-10 px-4 py-12 sm:px-6 md:grid-cols-4 lg:px-8">
        {/* Brand column */}
        <div>
          <h2 className="font-serif text-2xl font-semibold text-sage-700">
ISKCON Gurugram Sector 57
          </h2>
          <p className="mt-1 text-xs uppercase tracking-[0.2em] text-sage-600">
            Sri Radha Gopinath Temple
          </p>
          <p className="mt-4 text-sm leading-6 text-slate-600">
            A spiritual home for the Hare Krishna movement in Gurugram Sector 57 —
            daily kirtans, festivals, Gita classes, Annadanam, and cow
            protection.
          </p>
        </div>

        {/* Quick links */}
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-[0.2em] text-sage-700">
            Quick links
          </h3>
          <ul className="mt-4 space-y-2 text-sm">
            {NAV_LINKS.map((l) => (
              <li key={l.href}>
                <Link
                  href={l.href}
                  className="text-slate-700 transition-colors hover:text-sage-700"
                >
                  {l.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>

        {/* Contact */}
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-[0.2em] text-sage-700">
            Contact
          </h3>
          <address className="mt-4 space-y-2 text-sm not-italic text-slate-700">
            <p>
              ISKCON Sri Radha Gopinath Temple
              <br />
              Gurugram Sector 57, Haryana 122003
              <br />
              India
            </p>
            <p>
              <a
                href="tel:+919880685335"
                className="transition-colors hover:text-sage-700"
              >
                +91 98806 85335
              </a>
            </p>
            <p>
              <a
                href="mailto:info@iskconsecunderabad.org"
                className="transition-colors hover:text-sage-700"
              >
                info@iskconsecunderabad.org
              </a>
            </p>
          </address>
        </div>

        {/* Connect */}
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-[0.2em] text-sage-700">
            Connect
          </h3>
          <ul className="mt-4 space-y-2 text-sm">
            <li>
              <a
                href="https://wa.me/919880685335"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Chat with ISKCON Gurugram Sector 57 on WhatsApp"
                className="text-slate-700 transition-colors hover:text-sage-700"
              >
                WhatsApp
              </a>
            </li>
            <li>
              <a
                href="https://www.facebook.com/iskconsecunderabad"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="ISKCON Gurugram Sector 57 on Facebook"
                className="text-slate-700 transition-colors hover:text-sage-700"
              >
                Facebook
              </a>
            </li>
            <li>
              <a
                href="https://www.instagram.com/iskconsecunderabad"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="ISKCON Gurugram Sector 57 on Instagram"
                className="text-slate-700 transition-colors hover:text-sage-700"
              >
                Instagram
              </a>
            </li>
            <li>
              <a
                href="https://www.youtube.com/@iskconsecunderabad"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="ISKCON Gurugram Sector 57 on YouTube"
                className="text-slate-700 transition-colors hover:text-sage-700"
              >
                YouTube
              </a>
            </li>
          </ul>
        </div>
      </div>

      <div className="border-t border-sage-100">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-2 px-4 py-4 text-xs text-slate-600 sm:flex-row sm:px-6 lg:px-8">
          <p>© {year} ISKCON Gurugram Sector 57. All rights reserved.</p>
          <p>Built with devotion.</p>
        </div>
      </div>
    </footer>
  );
}
