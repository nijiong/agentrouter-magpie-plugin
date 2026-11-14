import { copyFile, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

export async function copyRuntimeModules(directory) {
  const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  // Follow the publish allowlist, never copy private local filter configuration.
  const files = manifest.files.filter(file => file.startsWith("src/") && file.endsWith(".mjs"));
  await Promise.all(files.map(file => copyFile(new URL("../../" + file, import.meta.url), join(directory, basename(file)))));
}
