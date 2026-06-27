"use client";

import { motion, useReducedMotion } from "framer-motion";

const WHATSAPP_URL = "https://wa.me/919880685335";

export default function WhatsAppFab() {
  const reduceMotion = useReducedMotion();

  return (
    <motion.a
      href={WHATSAPP_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Chat on WhatsApp"
      whileHover={reduceMotion ? undefined : { scale: 1.08 }}
      whileTap={reduceMotion ? undefined : { scale: 0.95 }}
      animate={
        reduceMotion
          ? undefined
          : {
              scale: [1, 1.06, 1],
            }
      }
      transition={
        reduceMotion
          ? { type: "spring", stiffness: 300, damping: 20 }
          : { repeat: Infinity, duration: 2.4, ease: "easeInOut" }
      }
      style={{ perspective: "600px", transformStyle: "preserve-3d" }}
      className="fixed bottom-6 right-6 z-40 inline-flex h-14 w-14 items-center justify-center rounded-full bg-[#25D366] text-white shadow-xl transition-colors hover:bg-[#1ebd5a] sm:h-16 sm:w-16"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 32 32"
        className="h-7 w-7 sm:h-8 sm:w-8"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M16 3C9.373 3 4 8.373 4 15c0 2.65.86 5.106 2.318 7.097L4 29l7.083-2.273A11.94 11.94 0 0 0 16 27c6.627 0 12-5.373 12-12S22.627 3 16 3zm0 21.6c-1.84 0-3.553-.493-5.018-1.342l-.36-.213-4.21 1.351 1.371-4.103-.235-.376A9.553 9.553 0 0 1 6.4 15c0-5.302 4.298-9.6 9.6-9.6S25.6 9.698 25.6 15 21.302 24.6 16 24.6zm5.546-7.157c-.302-.151-1.788-.882-2.066-.982-.277-.1-.48-.151-.682.151-.202.302-.781.982-.957 1.184-.176.202-.353.227-.655.076-.302-.151-1.275-.47-2.43-1.5-.898-.802-1.504-1.792-1.68-2.094-.176-.302-.019-.466.132-.617.135-.135.302-.353.453-.53.151-.176.202-.302.302-.504.1-.202.05-.378-.025-.53-.076-.151-.682-1.642-.935-2.247-.246-.59-.497-.51-.682-.52-.176-.008-.378-.01-.58-.01-.202 0-.53.076-.807.378-.277.302-1.058 1.034-1.058 2.522 0 1.488 1.084 2.924 1.235 3.126.151.202 2.131 3.252 5.166 4.561.722.312 1.286.498 1.725.637.725.231 1.385.198 1.906.12.582-.087 1.788-.731 2.04-1.437.252-.706.252-1.31.176-1.437-.076-.126-.277-.202-.58-.353z" />
      </svg>
    </motion.a>
  );
}
