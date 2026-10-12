import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Set base path for GitHub Pages deployment
  // Use './' for relative paths (works in subdirectories)
  // Or set to '/<repo-name>/' for absolute paths
  base: process.env.NODE_ENV === 'production' ? './' : '/',
  server: {
    host: "0.0.0.0",
    port: 3000,
    strictPort: true,
    hmr: {
      port: 3000,
    },
  },
});
