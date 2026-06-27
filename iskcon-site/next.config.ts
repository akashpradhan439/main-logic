import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  basePath: "/iskcon-site",
  output: "standalone",
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "static.wixstatic.com" },
      { protocol: "https", hostname: "payments.cashfree.com" },
    ],
  },
};

export default nextConfig;
