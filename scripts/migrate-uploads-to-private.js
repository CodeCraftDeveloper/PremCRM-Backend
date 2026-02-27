/**
 * Migration script: Move uploaded files from public/ to private/
 * Run once: node scripts/migrate-uploads-to-private.js
 */
import fs from "fs";
import path from "path";

const SRC = path.join(process.cwd(), "public", "uploads");
const DEST = path.join(process.cwd(), "private", "uploads");

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(src)) {
    console.log(`Source not found: ${src} — nothing to migrate.`);
    return 0;
  }
  fs.mkdirSync(dest, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      count += copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
      count++;
    }
  }
  return count;
}

const fileCount = copyDirRecursive(SRC, DEST);
console.log(
  `Migrated ${fileCount} file(s) from public/uploads → private/uploads`,
);
console.log(
  "You can now safely remove public/uploads/ after verifying the migration.",
);
