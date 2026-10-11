import { copyFile, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const likec4 = dirname(require.resolve("likec4/package.json"));
// LikeC4 ships this self-contained stylesheet; no CLI or font CDN at build/runtime.
await copyFile(resolve(likec4, "__app__/src/fonts.css"), resolve(root, "assets/fonts.css"));
await build({
  entryPoints: [resolve(root, "scripts/viewer.jsx")],
  outfile: resolve(root, "assets/app.js"),
  bundle: true, minify: true, format: "esm", platform: "browser", target: "es2022",
  loader: { ".css": "text" },
  // Escape multiline upstream CSS/string literals without changing their data.
  supported: { "template-literal": false },
  legalComments: "linked",
  define: { "process.env.NODE_ENV": '"production"' },
});

// Refresh this dependency's notice from its pinned installed source on every build.
const noticesPath = resolve(root, "assets/notices/THIRD-PARTY.txt");
const marker = "\n\nmodern-screenshot@";
const notices = (await readFile(noticesPath, "utf8")).split(marker)[0];
const capturePackage = dirname(require.resolve("modern-screenshot/package.json"));
const { version } = JSON.parse(await readFile(resolve(capturePackage, "package.json"), "utf8"));
const license = await readFile(resolve(capturePackage, "LICENSE"), "utf8");
// Normalize upstream line endings/whitespace without changing license wording.
await writeFile(noticesPath, `${notices}${marker}${version} (MIT)\nSource: https://github.com/qq15725/modern-screenshot/tree/v${version}\n\n${license}`.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, ""));
