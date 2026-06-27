import HeroVideo from "@/components/HeroVideo";
import CharitableActivities from "@/components/sections/CharitableActivities";
import BooksFeature from "@/components/sections/BooksFeature";
import LecturesSection from "@/components/sections/LecturesSection";
import SoulMelodies from "@/components/sections/SoulMelodies";
import DonateCTA from "@/components/sections/DonateCTA";
import CovidStrip from "@/components/sections/CovidStrip";
import WhatsAppFab from "@/components/sections/WhatsAppFab";

export default function Home() {
  return (
    <>
      <HeroVideo />
      <CharitableActivities />
      <BooksFeature />
      <LecturesSection />
      <SoulMelodies />
      <DonateCTA />
      <CovidStrip />
      <WhatsAppFab />
    </>
  );
}
