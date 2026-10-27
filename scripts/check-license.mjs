import { access, readFile } from "node:fs/promises";

const manifest = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

if (Object.hasOwn(manifest, "license")) {
  throw new Error("License metadata must remain unset until the project is release-ready");
}

try {
  await access(new URL("../LICENSE", import.meta.url));
  throw new Error("LICENSE must not be added until the project license has been deliberately selected");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

process.stdout.write("License declaration intentionally deferred; no LICENSE file is published.\n");
