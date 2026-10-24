import { copyFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const envPath = fileURLToPath(new URL("../.env", import.meta.url));
const examplePath = fileURLToPath(new URL("../.env.example", import.meta.url));

if (!existsSync(envPath)) {
  copyFileSync(examplePath, envPath);
  console.info(`Created ${envPath} from the checked-in development example.`);
}
