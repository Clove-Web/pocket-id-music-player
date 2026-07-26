// Applies schema.sql. Run with: bun run migrate

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { sql } from "./index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(join(here, "schema.sql"), "utf8");

console.log("Applying schema...");
await sql.unsafe(schema);
console.log("Schema applied.");

await sql.end();
