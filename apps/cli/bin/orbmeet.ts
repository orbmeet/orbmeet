#!/usr/bin/env node

import { run } from "../src/cli.ts";
import { handlePipeError, handleStdoutError } from "../src/process-errors.ts";

process.stdout.on("error", handleStdoutError);
process.stderr.on("error", handlePipeError);

void run(process.argv.slice(2));
