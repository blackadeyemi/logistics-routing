import { defineConfig, minimal2023Preset } from '@vite-pwa/assets-generator/config';

// Generates the PNG app icons from public/mark.svg: npm run icons
export default defineConfig({
  headLinkOptions: { preset: '2023' },
  preset: {
    ...minimal2023Preset,
    maskable: { ...minimal2023Preset.maskable, padding: 0.25, resizeOptions: { background: '#0f172a' } },
    apple: { ...minimal2023Preset.apple, padding: 0.2, resizeOptions: { background: '#0f172a' } },
  },
  images: ['public/mark.svg'],
});
