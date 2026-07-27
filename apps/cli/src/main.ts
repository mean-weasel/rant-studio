import { runCli } from './index.ts';

const baseUrl = process.env.RANT_STUDIO_URL;
const credential = process.env.RANT_STUDIO_CREDENTIAL;

if (!baseUrl || !credential) {
  process.stderr.write(
    'Set RANT_STUDIO_URL and RANT_STUDIO_CREDENTIAL from npm run service, then run npm run rant -- help.\n',
  );
  process.exitCode = 2;
} else {
  process.exitCode = await runCli(process.argv.slice(2), {
    baseUrl,
    credential,
    write: (line) => process.stdout.write(`${line}\n`),
  });
}
