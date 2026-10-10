import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed port. The fixtures live at the repo root.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, fs: { allow: [".."] } },
});
