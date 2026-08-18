/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // For static export (GitHub Pages), uncomment these lines:
  // output: "export",
  // trailingSlash: true,
  // images: { unoptimized: true },
  async rewrites() {
    const backend = process.env.BACKEND_URL || "http://127.0.0.1:8010";
    return [
      { source: "/api/:path*", destination: `${backend}/api/:path*` },
    ];
  },
};

export default nextConfig;
