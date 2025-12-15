require("ts-node").register({
  transpileOnly: true,
  compilerOptions: { module: "commonjs", moduleResolution: "node" }
});

require("../src/scripts/fetchTopHolders.ts");
