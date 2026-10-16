import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import mysql from 'mysql2/promise';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, '..', 'migrations');

export async function applyMigrations({ mysqlUrl, directory = migrationsDir, poolFactory = mysql.createPool }) {
  if (!mysqlUrl) throw new Error('MYSQL_URL is required; migration target is never inferred.');
  const pool = poolFactory(mysqlUrl, { multipleStatements: false, timezone: 'Z' });
  try {
    await pool.query("SET time_zone = '+00:00'");
    await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(64) NOT NULL PRIMARY KEY,
      checksum CHAR(64) NOT NULL,
      applied_at DATETIME(3) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    const files = (await fs.readdir(directory)).filter((file) => /^\d+__.*\.sql$/.test(file)).sort();
    const applied = new Map((await pool.query('SELECT version, checksum FROM schema_migrations'))[0].map((row) => [row.version, row.checksum]));
    let newlyApplied = 0;
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      const sql = await fs.readFile(path.join(directory, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      if (applied.has(version)) {
        if (applied.get(version) !== checksum) throw new Error(`Migration checksum mismatch: ${version}`);
        continue;
      }
      for (const statement of sql.split(';').map((item) => item.trim()).filter(Boolean)) await pool.query(statement);
      await pool.execute('INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(?,?,UTC_TIMESTAMP(3))', [version, checksum]);
      newlyApplied += 1;
    }
    return { applied: newlyApplied };
  } finally { await pool.end(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes('--apply')) {
    process.stderr.write('Migration execution is disabled by default. Obtain approval, then pass --apply explicitly.\n');
    process.exitCode = 2;
  } else {
    const mysqlUrl = process.env.MYSQL_URL || '';
    applyMigrations({ mysqlUrl }).then((result) => {
      process.stdout.write(`Migrations checked. Newly applied: ${result.applied}\n`);
    }).catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
  }
}
