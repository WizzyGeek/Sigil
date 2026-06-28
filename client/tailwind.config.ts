import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Space Grotesk"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'monospace'],
      },
      colors: {
        gold: {
          DEFAULT: '#d6b06a',
          light: '#e8cf94',
          dark: '#c79a4f',
        },
      },
    },
  },
  plugins: [],
} satisfies Config
