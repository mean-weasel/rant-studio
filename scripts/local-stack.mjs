import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SESSION_NAME = 'rant-studio-local';
const RESTART_DELAY_MS = 1_000;
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.dirname(path.dirname(SCRIPT_PATH));
const action = process.argv[2] ?? 'status';

function runTmux(args, options = {}) {
  return spawnSync('tmux', args, {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    ...options,
  });
}

function hasSession() {
  return runTmux(['has-session', '-t', SESSION_NAME]).status === 0;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function requireTmux() {
  const result = runTmux(['-V']);
  if (result.status === 0) return;

  console.error(
    'tmux is required for the persistent local stack. Install it with `brew install tmux`.',
  );
  process.exit(1);
}

function startSession() {
  if (hasSession()) {
    console.log(
      `Rant Studio local stack is already running (${SESSION_NAME}).`,
    );
    return;
  }

  const command = [process.execPath, SCRIPT_PATH, 'supervise']
    .map(shellQuote)
    .join(' ');
  const result = runTmux([
    'new-session',
    '-d',
    '-s',
    SESSION_NAME,
    '-c',
    PROJECT_ROOT,
    command,
  ]);

  if (result.status !== 0) {
    console.error(
      result.stderr || 'Unable to start the Rant Studio local stack.',
    );
    process.exit(result.status ?? 1);
  }

  console.log('Rant Studio local stack started.');
  console.log('Web: http://rant-studio.localhost:4173/?mode=intake');
  console.log('Use `npm run local:logs` to inspect startup output.');
}

function stopSession() {
  if (!hasSession()) {
    console.log('Rant Studio local stack is already stopped.');
    return;
  }

  const result = runTmux(['kill-session', '-t', SESSION_NAME]);
  if (result.status !== 0) {
    console.error(
      result.stderr || 'Unable to stop the Rant Studio local stack.',
    );
    process.exit(result.status ?? 1);
  }

  console.log('Rant Studio local stack stopped.');
}

function showStatus() {
  if (!hasSession()) {
    console.log('Rant Studio local stack is stopped.');
    process.exitCode = 1;
    return;
  }

  const result = runTmux([
    'list-panes',
    '-t',
    SESSION_NAME,
    '-F',
    '#{session_name}: #{pane_current_command} (pane #{pane_id})',
  ]);
  console.log('Rant Studio local stack is running.');
  if (result.stdout) console.log(result.stdout.trim());
}

function showLogs() {
  if (!hasSession()) {
    console.error('Rant Studio local stack is stopped.');
    process.exitCode = 1;
    return;
  }

  const result = runTmux([
    'capture-pane',
    '-p',
    '-S',
    '-200',
    '-t',
    SESSION_NAME,
  ]);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.status ?? 1;
}

function supervise() {
  const specs = [
    { name: 'service', args: ['run', 'service'] },
    { name: 'web', args: ['run', 'dev'] },
  ];
  const children = new Map();
  let shuttingDown = false;

  const launch = (spec) => {
    console.log(`[local-stack] starting ${spec.name}`);
    const child = spawn('npm', spec.args, {
      cwd: PROJECT_ROOT,
      env: process.env,
      stdio: 'inherit',
    });
    children.set(spec.name, child);

    child.once('exit', (code, signal) => {
      children.delete(spec.name);
      if (shuttingDown) return;

      console.error(
        `[local-stack] ${spec.name} stopped (${signal ?? code ?? 'unknown'}); restarting`,
      );
      setTimeout(() => launch(spec), RESTART_DELAY_MS);
    });
  };

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of children.values()) child.kill('SIGTERM');
    setTimeout(() => process.exit(0), 2_000).unref();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  for (const spec of specs) launch(spec);
}

requireTmux();

switch (action) {
  case 'up':
    startSession();
    break;
  case 'restart':
    stopSession();
    startSession();
    break;
  case 'status':
    showStatus();
    break;
  case 'logs':
    showLogs();
    break;
  case 'down':
    stopSession();
    break;
  case 'supervise':
    supervise();
    break;
  default:
    console.error(`Unknown local stack action: ${action}`);
    process.exitCode = 1;
}
