import { defineConfig } from "vite";

// GitHub Pages serves a project site under /<repo>/. Use a relative base so the
// built assets and the public/data/*.json files resolve under any subpath.
export default defineConfig({
  base: "./",
});
