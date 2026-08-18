/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: { unoptimized: true },
};

// Only enable static export for production builds (GitHub Pages)
if (process.env.NODE_ENV === 'production' && process.env.STATIC_EXPORT === '1') {
  nextConfig.output = 'export';
  nextConfig.trailingSlash = true;
}

export default nextConfig;
