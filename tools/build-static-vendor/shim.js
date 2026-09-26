// isomorphic-git's core uses the Node `Buffer`/`process` globals directly
// (not via bare imports esbuild could resolve on its own), which don't
// exist in a browser. This polyfills just enough for it to run unbundled
// in static/index.html.
import { Buffer } from "buffer";
import processPolyfill from "process/browser.js";

if (typeof globalThis.Buffer === "undefined") globalThis.Buffer = Buffer;
if (typeof globalThis.process === "undefined") globalThis.process = processPolyfill;
if (typeof globalThis.global === "undefined") globalThis.global = globalThis;
