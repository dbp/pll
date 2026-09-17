import { main } from "./main";
import { EXIT } from "./run";

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`pll: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(EXIT.usage);
  },
);
