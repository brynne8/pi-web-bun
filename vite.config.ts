import { createRequire } from "node:module";
import { defineConfig, type Plugin } from "vite";
import vinext from "vinext";
import { nextConfig } from "./next-config.ts";

const require = createRequire(import.meta.url);
const { rewriteGfmAutolinkEmailRegex } = require("./lib/gfm-autolink-email-loader.cjs") as {
  rewriteGfmAutolinkEmailRegex: (source: string) => string;
};

// mdast-util-gfm-autolink-literal (remark-gfm) ships a RegExp lookbehind that
// Safari parses only from 16.4, which blanked `/` on iOS 16.2 (#753). The
// loader swaps it for an equivalent built at runtime.
function gfmAutolinkEmail(): Plugin {
  return {
    name: "pi-web:gfm-autolink-email",
    enforce: "pre",
    transform(code, id) {
      const file = id.split("?", 1)[0];
      if (!/[\\/]mdast-util-gfm-autolink-literal[\\/]lib[\\/]index\.js$/.test(file)) return null;
      return { code: rewriteGfmAutolinkEmailRegex(code), map: null };
    },
  };
}

// vinext bakes its on-demand revalidation secret into the server bundle, and a
// request carrying it skips proxy.ts. A published tarball would ship that
// value, so leave the build-time override empty: vinext then omits the define
// and the runtime generates a fresh per-process secret. (The prerender secret
// lives in a file instead; bin/vinext-secrets.cjs removes it at launch.)
process.env.__VINEXT_SHARED_REVALIDATE_SECRET = "";

export default defineConfig({
  // vinext serves `_next/static` bytes as built: without precompressed
  // variants a browser downloads and parses the client graph raw (2.3 MB at
  // the time of writing, 0.55 MB brotli), which is what a slower machine
  // waits on first. The build writes .br/.gz beside each asset and the server
  // negotiates on Accept-Encoding.
  plugins: [gfmAutolinkEmail(), vinext({ nextConfig, precompress: true })],
  // Vite 8's baseline is newer than Safari 16.2; mermaid's class `static {}`
  // blocks and the rest of the client graph must be lowered for it (#753).
  build: { target: "safari16.2" },
  // A pre-bundled dependency never reaches the transform hook above.
  optimizeDeps: { exclude: ["mdast-util-gfm-autolink-literal"] },
});
