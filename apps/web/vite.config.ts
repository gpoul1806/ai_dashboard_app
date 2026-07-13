import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // All data + generated modules come from the Express server.
      "/api": "http://localhost:3001",
    },
  },
});
