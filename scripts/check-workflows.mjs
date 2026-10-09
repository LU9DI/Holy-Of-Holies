import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(".github/workflows");
const files = (await readdir(root)).filter((name) => /\.ya?ml$/i.test(name)).sort();
if (files.length === 0) throw new Error("no workflow files found");

const failures = [];
for (const file of files) {
  const source = await readFile(path.join(root, file), "utf8");
  for (const [index, line] of source.split("\n").entries()) {
    const match = /^\s*uses:\s*([^\s#]+)/.exec(line);
    if (!match) continue;
    const reference = match[1];
    if (reference.startsWith("./")) continue;
    if (!/^[^/]+\/[^/@]+(?:\/[^@]+)?@[a-f0-9]{40}$/.test(reference)) {
      failures.push(`${file}:${index + 1}: external action must be pinned to a full 40-character commit SHA`);
    }
  }

  if (!/^permissions:\s*\n(?:[ \t]+[^\n]*\n)+/m.test(source)) {
    failures.push(`${file}: top-level least-privilege permissions block is required`);
  }
  if (/^permissions:\s*\n[ \t]+(?:write-all|[^\n]+:\s*write-all)\s*$/m.test(source)) {
    failures.push(`${file}: write-all permissions are forbidden`);
  }
}

if (failures.length) {
  process.stderr.write(`Workflow security check failed:\n- ${failures.join("\n- ")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Workflow security check passed for ${files.length} workflow file(s).\n`);
}
