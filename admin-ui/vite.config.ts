import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import tailwindcss from "@tailwindcss/vite";
import tanstackRouter from "@tanstack/router-plugin/vite";

export default defineConfig({
  base: "/console/",
  plugins: [
    tanstackRouter({
      generatedRouteTree: "./src/routes/routeTree.gen.ts",
      routeFileIgnorePattern: "routeTree.gen",
    }),
    react(),
    tsconfigPaths(),
    tailwindcss(),
  ],
  server: {
    port: 5173,
    proxy: {
      "/admin": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
      "/ready": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
      "/worker-status": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
