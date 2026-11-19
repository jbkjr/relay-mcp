// Writes every host's adapter (see generate.mjs). Run after building:
// npm run build && node adapters/build.mjs
// A directory given as an argument is written in place of adapters/ itself.
import path from "node:path";
import { buildAdapters } from "./generate.mjs";

buildAdapters(process.argv[2] ? path.resolve(process.argv[2]) : undefined);
console.log("adapters written");
