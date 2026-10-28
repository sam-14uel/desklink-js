#!/usr/bin/env node
import { run } from "../dist/cli.js";
run().catch((err) => {
  console.error(err);
  process.exit(1);
});
