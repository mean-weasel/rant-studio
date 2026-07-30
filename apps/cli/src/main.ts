import { runCli } from './index.ts';

async function readPipedSecret(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '');
}

function readHiddenSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    return readPipedSecret();
  }
  return new Promise((resolve, reject) => {
    let secret = '';
    const wasRaw = process.stdin.isRaw;
    const finish = (error?: Error) => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
      process.stderr.write('\n');
      if (error) reject(error);
      else resolve(secret);
    };
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3) {
          finish(new Error('Credential input canceled'));
          return;
        }
        if (byte === 10 || byte === 13) {
          finish();
          return;
        }
        if (byte === 8 || byte === 127) {
          secret = secret.slice(0, -1);
          continue;
        }
        secret += String.fromCharCode(byte);
      }
    };
    process.stderr.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

const baseUrl = process.env.RANT_STUDIO_URL;
const credential = process.env.RANT_STUDIO_CREDENTIAL;

if (!baseUrl) {
  process.stderr.write(
    'Set RANT_STUDIO_URL from npm run service, then run npm run rant -- help. External agents must also set RANT_STUDIO_CREDENTIAL.\n',
  );
  process.exitCode = 2;
} else {
  process.exitCode = await runCli(process.argv.slice(2), {
    baseUrl,
    credential,
    readSecret: ({ prompt, stdin }) =>
      stdin ? readPipedSecret() : readHiddenSecret(prompt),
    write: (line) => process.stdout.write(`${line}\n`),
  });
}
