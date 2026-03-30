import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["index.ts"],
  format: ["esm"],
  target: "es2022",
  clean: true,
  dts: false,
  sourcemap: true,
  minify: false,
  noExternal: [/^(?!openclaw)/],
  external: [/^openclaw(\/.*)?$/],
  treeshake: true,
  outDir: "dist",
});
