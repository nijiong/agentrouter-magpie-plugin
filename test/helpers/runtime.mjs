import { copyFile, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

export async function copyRuntimeModules(directory) {
  const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  // 遵循发布白名单，绝不复制私有的本地过滤配置。
  const files = manifest.files.filter(file => file.startsWith("src/") && file.endsWith(".mjs"));
  await Promise.all(files.map(file => copyFile(new URL("../../" + file, import.meta.url), join(directory, basename(file)))));
}
