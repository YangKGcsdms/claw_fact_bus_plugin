import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["index.ts"],
  format: ["esm"],
  target: "es2022",
  clean: true,
  dts: true,
  sourcemap: true,
  minify: false,
  noExternal: [/.*/],
  external: ["openclaw"],
  treeshake: true,
  outDir: "dist",
});
