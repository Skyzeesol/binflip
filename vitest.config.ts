import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  // research/ uses node:test (run with `node --test research/ilginc/*.test.mjs`)
  test: { exclude: [...configDefaults.exclude, "research/**"] },
});
