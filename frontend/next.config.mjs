// Statik export: `next build` -> out/. Backend container'i bu dosyalari "/" altinda sunar,
// API ile ayni origin oldugu icin CORS ve ayri frontend servisi gerekmez.
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  poweredByHeader: false,
  images: { unoptimized: true },
};

export default nextConfig;
