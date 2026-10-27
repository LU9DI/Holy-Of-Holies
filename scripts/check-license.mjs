import { access, readFile } from "node:fs/promises";

const manifest = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

if (Object.hasOwn(manifest, "license")) {
  throw new Error("Do not declare a license until the repository licensing review is approved");
}

try {
  await access(new URL("../LICENSE", import.meta.url));
  throw new Error("LICENSE exists but package.json has no license declaration; reconcile both deliberately");
} catch (error) {
  if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
    process.stdout.write("No license declared; licensing decision intentionally deferred.\n");
  } else {
    throw error;
  }
}
