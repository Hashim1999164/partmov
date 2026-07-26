/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@partmov/protocol"],
  env: {
    NEXT_PUBLIC_STREAMING_V2: process.env.NEXT_PUBLIC_STREAMING_V2 ?? "false",
    NEXT_PUBLIC_API_BASE: process.env.NEXT_PUBLIC_API_BASE ?? "http://127.0.0.1:8080",
    NEXT_PUBLIC_SYNC_WS: process.env.NEXT_PUBLIC_SYNC_WS ?? "ws://127.0.0.1:8090/ws",
  },
};

export default nextConfig;
