/**
 * 解决 github.com 被解析到不通 IP 导致 push 失败的问题。
 *
 * 背景：这台机器的 DNS 有时会把 github.com 解析到 20.205.243.166，
 * 该地址 443 端口连不上，而 GitHub 其他入口 IP 是通的。
 * 本脚本会依次探测候选 IP，用第一个能连通的地址完成 push。
 *
 * 用法：node scripts/push.mjs [git push 的额外参数]
 */
import net from 'node:net';
import { spawnSync } from 'node:child_process';

/** GitHub 常见的入口地址，探测到可用的就用它 */
const CANDIDATES = [
  '140.82.112.3',
  '140.82.113.3',
  '140.82.114.3',
  '140.82.116.3',
  '20.27.177.113',
  '4.237.22.38',
];

function canConnect(ip, port = 443, timeout = 2500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, ip);
  });
}

const args = process.argv.slice(2);
const extraArgs = args.length ? args : [];

async function main() {
  // 先按原样试一次，避免在能正常解析的网络上多此一举
  const direct = spawnSync('git', ['push', ...extraArgs], { stdio: 'inherit', shell: false });
  if (direct.status === 0) {
    console.log('\n推送完成（直连成功）');
    return;
  }

  console.log('\n直连失败，开始探测可用 IP…');
  const results = await Promise.all(CANDIDATES.map((ip) => canConnect(ip)));
  const usable = CANDIDATES.filter((_, i) => results[i]);

  if (usable.length === 0) {
    console.error('所有候选 IP 都不通，可能是网络被完全阻断。');
    process.exitCode = 1;
    return;
  }
  console.log(`可用 IP: ${usable.join(', ')}`);

  for (const ip of usable) {
    console.log(`\n尝试通过 ${ip} 推送…`);
    const r = spawnSync(
      'git',
      ['-c', `http.curloptResolve=github.com:443:${ip}`, 'push', ...extraArgs],
      { stdio: 'inherit', shell: false },
    );
    if (r.status === 0) {
      console.log(`\n推送完成（经 ${ip}）`);
      return;
    }
  }

  console.error('\n所有可用 IP 均推送失败。');
  process.exitCode = 1;
}

main();
