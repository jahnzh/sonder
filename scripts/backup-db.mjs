// Consistent online backup of a Sonder SQLite database.
//
//   node scripts/backup-db.mjs <source-db> <destination-db>
//
// The backup function lives in server/db-backup.mjs, shared with the server's daily backups
// (#361); this file is the command `npm run backup` and scripts/deploy.sh run.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BackupError, backupDatabase } from "../server/db-backup.mjs";

export { BackupError, backupDatabase };

const USAGE = "usage: node scripts/backup-db.mjs <source-db> <destination-db>";

async function main(argv) {
  const args = argv.slice(2);
  if (args.length !== 2) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  try {
    const result = await backupDatabase(args[0], args[1]);
    process.stdout.write(`backup-db: wrote ${result.destination} (${result.bytes} bytes)\n`);
    return 0;
  } catch (error) {
    const message = error instanceof BackupError ? error.message : String(error?.message ?? error);
    process.stderr.write(`backup-db: ${message}\n`);
    return 1;
  }
}

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  main(process.argv).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`backup-db: ${error?.message ?? error}\n`);
      process.exitCode = 1;
    },
  );
}
