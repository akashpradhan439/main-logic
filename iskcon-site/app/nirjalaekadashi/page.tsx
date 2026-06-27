import AnnadanHero from "@/components/nirjala/AnnadanHero";
import AnnadanSection from "@/components/nirjala/AnnadanSection";
import GausevaSection from "@/components/nirjala/GausevaSection";
import ModiVideo from "@/components/nirjala/ModiVideo";
import BankDetails from "@/components/nirjala/BankDetails";

export const metadata = {
  title: "Nirjala Ekadashi · Annadan & Gauseva · ISKCON Gurugram Sector 57",
  description:
    "Donate to feed the hungry and protect cows through ISKCON Gurugram Sector 57's Nirjala Ekadashi campaign",
};

export default function NirjalaEkadashiPage() {
  return (
    <>
      <AnnadanHero />
      <AnnadanSection />
      <GausevaSection />
      <ModiVideo />
      <BankDetails />
    </>
  );
}
