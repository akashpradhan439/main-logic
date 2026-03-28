import i18next from "i18next";
import en from "../locales/en.json" with { type: "json" };
import ar from "../locales/ar.json" with { type: "json" };
import bn from "../locales/bn.json" with { type: "json" };
import es from "../locales/es.json" with { type: "json" };
import fr from "../locales/fr.json" with { type: "json" };
import hi from "../locales/hi.json" with { type: "json" };
import ja from "../locales/ja.json" with { type: "json" };
import pt from "../locales/pt.json" with { type: "json" };
import ru from "../locales/ru.json" with { type: "json" };
import zhHans from "../locales/zh-Hans.json" with { type: "json" };
import zhHant from "../locales/zh-Hant.json" with { type: "json" };

// Initialize i18next
i18next.init({
  resources: {
    en: { translation: en },
    ar: { translation: ar },
    bn: { translation: bn },
    es: { translation: es },
    fr: { translation: fr },
    hi: { translation: hi },
    ja: { translation: ja },
    pt: { translation: pt },
    ru: { translation: ru },
    "zh-Hans": { translation: zhHans },
    "zh-Hant": { translation: zhHant }
  },
  fallbackLng: "en",
  preload: ["en", "ar", "bn", "es", "fr", "hi", "ja", "pt", "ru", "zh-Hans", "zh-Hant"],
});

/**
 * Basic Accept-Language parser.
 * Examples: "en-US,en;q=0.9,es;q=0.8", "es-ES,es;q=0.9"
 * Returns the best matching supported language.
 */
export function getLanguageFromHeader(acceptLanguage?: string): string {
  if (!acceptLanguage) return "en";

  const languages = acceptLanguage.split(",").map((lang) => {
    const [code, qVal] = lang.split(";");
    const q = qVal && qVal.startsWith("q=") ? parseFloat(qVal.substring(2)) : 1.0;
    // Extract base language code (e.g., 'es' from 'es-ES')
    const baseCode = code ? code.trim().split("-")[0] : undefined;
    return { code: baseCode, q };
  });

  // Sort by quality value (q) descending
  languages.sort((a, b) => b.q - a.q);

  // Find the first supported language
  for (const lang of languages) {
    if (lang.code && i18next.options.resources && i18next.options.resources[lang.code]) {
      return lang.code;
    }
  }

  return "en"; // default fallback
}

export function getTranslator(acceptLanguageHeader?: string) {
  const lng = getLanguageFromHeader(acceptLanguageHeader);
  return i18next.getFixedT(lng);
}

// Extend FastifyRequest interface
declare module "fastify" {
  interface FastifyRequest {
    t: ReturnType<typeof i18next.getFixedT>;
  }
}
