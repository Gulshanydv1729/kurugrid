import type { Config } from "tailwindcss";

/**
 * Bloomberg/Binance terminal aesthetic:
 * dark zinc canvas, violet/purple accent rail, emerald = bid, rose = ask.
 */
const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        accent: {
          400: "#a78bfa",
          500: "#8b5cf6",
          600: "#7c3aed",
        },
        bid: "#10b981",
        ask: "#f43f5e",
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
      boxShadow: {
        panel: "inset 0 1px 0 0 rgb(255 255 255 / 0.04)",
      },
      keyframes: {
        "pulse-row": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.45" },
        },
        "slide-in": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "pulse-row": "pulse-row 1.1s ease-in-out infinite",
        "slide-in": "slide-in 180ms ease-out both",
      },
    },
  },
  plugins: [],
};

export default config;
