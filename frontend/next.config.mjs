/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Static export for GitHub Pages / static hosting
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  // Disable rewrites for static export (API calls go directly to backend)
  // rewrites are only used in local development
};

export default nextConfig;
