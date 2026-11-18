// Local dashboard preview with no model quota and no real data writes:
// the scripted stand-in model and a separate PGlite database (.data/preview-db).
// Fill it first:  npm run synthetic -- --preview
//   npm run dev:preview      dev server on :3200 (hot reload)
//   npm run start:preview    production build on :3201 (run `npm run build` first), as Vercel serves it
import { spawn } from 'node:child_process';

const prod = process.argv.includes('--start');
const env = { ...process.env, RELAY_OFFLINE: '1', RELAY_DB_DIR: '.data/preview-db' };
delete env.DATABASE_URL;
const port = String(Number(process.env.PORT) || (prod ? 3201 : 3200));
const child = spawn(`npx next ${prod ? 'start' : 'dev'} -p ${port}`, { env, stdio: 'inherit', shell: true });
child.on('exit', (code) => process.exit(code ?? 0));
