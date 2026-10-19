/**
 * 一键开发模式：同时启动后端（watch）与前端（Vite HMR）。
 * 用法：pnpm dev
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';

const children = [];

function run(name, cmd, args, cwd, color) {
  const child = spawn(isWin ? 'cmd' : 'sh', isWin ? ['/c', `${cmd} ${args.join(' ')}`] : ['-c', `${cmd} ${args.join(' ')}`], {
    cwd,
    env: { ...process.env, FORCE_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const tag = `\x1b[${color}m[${name}]\x1b[0m `;
  const pipe = (stream, out) => {
    stream.setEncoding('utf8');
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) out.write(tag + line + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);

  child.on('exit', (code) => {
    console.log(`${tag}进程退出，代码 ${code}`);
    shutdown();
  });

  children.push(child);
  return child;
}

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    try {
      c.kill();
    } catch {
      /* ignore */
    }
  }
  setTimeout(() => process.exit(0), 300);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log('\n  NovelForge 开发模式启动中…\n');

run('server', 'pnpm', ['--filter', '@novelforge/server', 'dev'], root, '36');
setTimeout(() => {
  run('web', 'pnpm', ['--filter', '@novelforge/web', 'dev'], root, '35');
}, 1200);

console.log('  后端 http://127.0.0.1:8787');
console.log('  前端 http://127.0.0.1:5173  （改代码自动热更新）\n');
