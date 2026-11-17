// Local dashboard preview with no model quota and no real data:
// the scripted stand-in model and a separate PGlite database (.data/preview-db).
// Fill it first:  npm run synthetic -- --preview
import { spawn } from 'node:child_process';

const env = { ...process.env, RELAY_OFFLINE: '1', RELAY_DB_DIR: '.data/preview-db' };
delete env.DATABASE_URL;
const port = String(Number(process.env.PORT) || 3200);
const child = spawn(`npx next dev -p ${port}`, { env, stdio: 'inherit', shell: true });
child.on('exit', (code) => process.exit(code ?? 0));
