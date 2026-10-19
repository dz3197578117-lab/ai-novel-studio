import fs from 'node:fs';
import path from 'node:path';

for (const dir of ['apps/server/dist', 'apps/web/dist', 'apps/server/data']) {
  const abs = path.resolve(dir);
  if (fs.existsSync(abs)) {
    fs.rmSync(abs, { recursive: true, force: true });
    console.log(`removed ${dir}`);
  }
}
console.log('清理完成');
