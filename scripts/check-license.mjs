import { readFile } from "node:fs/promises";

const manifest = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const licenseText = await readFile(new URL("../LICENSE", import.meta.url), "utf8");

if (manifest.license !== "AGPL-3.0-or-later") {
  throw new Error("package.json license must match the project license");
}
if (!licenseText.startsWith("GNU AFFERO GENERAL PUBLIC LICENSE\nVersion 3, 19 November 2007")) {
  throw new Error("LICENSE does not contain the expected GNU AGPL version 3 text");
}
if (!licenseText.includes("END OF TERMS AND CONDITIONS")) {
  throw new Error("LICENSE appears incomplete");
}

process.stdout.write("License metadata and AGPL-3.0-or-later text are consistent.\n");
