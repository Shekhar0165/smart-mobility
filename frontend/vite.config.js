import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    conditions: ["onnxruntime-web-use-extern-wasm"],
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.js",
    globals: true,
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          charts: ["recharts"],
          motion: ["framer-motion"],
          vendor: [
            "react",
            "react-dom",
            "react-router-dom",
            "socket.io-client",
          ],
        },
      },
    },
  },
});
