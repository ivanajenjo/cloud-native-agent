import { defineConfig } from "vite";

export default defineConfig({
  base: "/ui/",
  // @cna/shared resolves to its TypeScript sources in development.
  resolve: { conditions: ["development", "module", "browser"] },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    target: "es2022",
    modulePreload: { polyfill: false },
  },
});
