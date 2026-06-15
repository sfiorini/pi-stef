import { writeFileSync } from "node:fs";

import { CONFIG_SCHEMA } from "../src/schema.mjs";

writeFileSync(new URL("../config.schema.json", import.meta.url), JSON.stringify(CONFIG_SCHEMA, null, 2) + "\n");
console.log("Wrote config.schema.json");
