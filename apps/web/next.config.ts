import type { NextConfig } from "next";

// The browser only talks to this server; /api/* is proxied to the Binflip API
// (same origin, so the session cookie stays httpOnly + SameSite=strict).
const api = process.env.API_URL ?? "http://127.0.0.1:3001";

const config: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${api}/:path*` }];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
};

export default config;
