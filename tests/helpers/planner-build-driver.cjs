// Observe actual CJS bundle imports; do not change the build, CLI arguments or output.
const fs = require("node:fs");
const Module = require("node:module");
const { basename } = require("node:path");
const { pathToFileURL } = require("node:url");
const [wrapper, report] = process.argv.slice(2);
const bundles = [];
const originalLoad = Module.prototype.load;
Module.prototype.load = function (filename) {
  if (basename(filename) === "cli.cjs") bundles.push(filename);
  return originalLoad.call(this, filename);
};
process.on("exit", () => fs.writeFileSync(report, JSON.stringify({ bundles })));
process.argv = [process.execPath, wrapper];
import(pathToFileURL(wrapper).href);
