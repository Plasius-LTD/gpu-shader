import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    node: "src/node.ts",
    testing: "src/testing.ts",
    cli: "src/cli.ts",
  },
  dts: true,
  sourcemap: true,
  clean: true,
  format: ["esm", "cjs"],
  target: "es2022",
  splitting: false,
  noExternal: ["wgsl_reflect"],
  esbuildOptions(options, context) {
    options.define = {
      ...options.define,
      __PLASIUS_MODULE_URL__: context.format === "cjs" ? "__filename" : "import.meta.url",
    };
  },
});
