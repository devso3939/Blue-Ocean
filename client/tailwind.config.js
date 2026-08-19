/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        background: 'hsl(228 24% 6%)',
        foreground: 'hsl(220 25% 94%)',
        card: 'hsl(227 22% 9%)',
        'card-foreground': 'hsl(220 25% 94%)',
        primary: 'hsl(250 80% 70%)',
        'primary-foreground': 'hsl(250 40% 8%)',
        secondary: 'hsl(226 18% 14%)',
        'secondary-foreground': 'hsl(220 20% 88%)',
        muted: 'hsl(226 18% 14%)',
        'muted-foreground': 'hsl(222 12% 58%)',
        accent: 'hsl(246 40% 18%)',
        'accent-foreground': 'hsl(250 80% 82%)',
        border: 'hsl(226 18% 15%)',
        ring: 'hsl(250 80% 70%)',
      },
      borderRadius: {
        xl: '0.75rem',
      }
    },
  },
  plugins: [],
}
