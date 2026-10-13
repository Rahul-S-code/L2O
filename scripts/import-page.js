// Turns the UC Order Hub artifact page into the hosted page.
//   node scripts/import-page.js <artifact index.html> [public/index.html]
// Run it whenever the artifact (the prototype on claude.ai) changes, so this site keeps the same order flow.
// It only swaps the CDN libraries for local copies and adds hosted.js; the page's code is left as it is.
const fs = require("fs");
const [src, out = require("path").join(__dirname, "..", "public", "index.html")] = process.argv.slice(2);
if (!src) { console.error("usage: node scripts/import-page.js <artifact.html> [out.html]"); process.exit(1); }
let html = fs.readFileSync(src, "utf8");
const swaps = [
  [/<script src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/xlsx\/0\.18\.5\/xlsx\.full\.min\.js"><\/script>/,
   '<script src="vendor/xlsx-0.18.5.full.min.js"></script>\n<script src="hosted.js"></script>'],
  [/https:\/\/cdn\.jsdelivr\.net\/npm\/exceljs@4\.4\.0\/dist\/exceljs\.min\.js/g, "vendor/exceljs-4.4.0.min.js"],
];
for (const [re, to] of swaps) {
  if (!re.test(html)) { console.error("Couldn't find " + re + " in the page. Has the library version changed? Update scripts/import-page.js and public/vendor."); process.exit(1); }
  html = html.replace(re, to);
}
const left = html.match(/https:\/\/(cdnjs|cdn\.jsdelivr|unpkg)[^"' )]+/g);
if (left) console.warn("Still loaded from a CDN (add a local copy if this site can't reach it):\n  " + [...new Set(left)].join("\n  "));
fs.writeFileSync(out, html);
console.log("Wrote " + out);
