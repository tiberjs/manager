import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "@rspack/cli";

const root = process.cwd();
const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const entries = {};

function addEntry(target) {
  const output = typeof target === "string" ? target : target?.import;
  if (!output?.startsWith("./dist/") || !output.endsWith(".js")) {
    return;
  }

  const name = output.slice("./dist/".length, -".js".length);
  const source = `./src/${name}.ts`;
  if (!existsSync(path.join(root, source))) {
    throw new Error(`${manifest.name}: missing public entry ${source}`);
  }
  entries[name] = source;
}

for (const target of Object.values(manifest.exports ?? {})) {
  addEntry(target);
}
addEntry(manifest.main);

if (Object.keys(entries).length === 0) {
  throw new Error(`${manifest.name}: no public JavaScript entry points`);
}

export default defineConfig({
  context: root,
  mode: "production",
  target: "node24",
  externalsType: "module",
  externals: [/^[^./]/],
  entry: entries,
  devtool: "source-map",
  experiments: {
    outputModule: true,
  },
  output: {
    path: path.join(root, "dist"),
    filename: "[name].js",
    chunkFilename: "[name].js",
    clean: true,
    module: true,
    library: {
      type: "module",
    },
  },
  resolve: {
    extensionAlias: {
      ".js": [".ts", ".js"],
    },
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        loader: "builtin:swc-loader",
        options: {
          jsc: {
            parser: {
              syntax: "typescript",
              decorators: true,
            },
            target: "es2022",
          },
        },
      },
    ],
  },
  optimization: {
    minimize: false,
  },
});
