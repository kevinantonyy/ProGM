/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        primary: {
          50: '#EAF3FF',
          100: '#D4E8FF',
          200: '#A9D0FF',
          300: '#7DB8FF',
          400: '#58A6FF',
          500: '#2F81F7',
          600: '#2F81F7',
          700: '#1F6FEB',
          800: '#174EA6',
          900: '#0D2A4D',
        },
        dark: {
          50: '#F0F3F6',
          100: '#E6EAF0',
          200: '#D0D7DE',
          300: '#B6BEC8',
          400: '#8B949E',
          500: '#6E7781',
          600: '#364150',
          700: '#27313D',
          800: '#131922',
          900: '#0F141B',
          950: '#0B0F14',
        },
        accent: {
          green: '#3FB950',
          red: '#F85149',
          orange: '#D29922',
          purple: '#A371F7',
        },
        green: { 400: '#3FB950' },
        red: { 400: '#F85149' },
        orange: { 400: '#D29922' },
      },
    },
  },
  plugins: [],
};
