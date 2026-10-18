import { defineConfig } from "vite";

// https://vitejs.dev/config
export default defineConfig({
  // dur.io (D3): optional server address suggested on first launch, empty by default
  define: {
    __DURIO_DEFAULT_SERVER__: JSON.stringify(
      process.env.DURIO_DEFAULT_SERVER ?? "",
    ),
  },
  build: {
    rollupOptions: {
      external: ["node-pipewire"],
    },
  },
});
