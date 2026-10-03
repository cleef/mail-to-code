import { open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
export async function acquireLease(dataDir: string) {
    const path = join(dataDir, 'daemon.lock');
    const create = async () => { const file = await open(path, 'wx', 0o600); await file.writeFile(JSON.stringify({ pid: process.pid })); await file.close(); };
    try {
        await create();
    }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST')
            throw e;
        const owner = JSON.parse(await readFile(path, 'utf8')) as {
            pid: number;
        };
        if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0)
            throw new Error('Invalid daemon lock; inspect before recovery');
        try {
            process.kill(owner.pid, 0);
            throw new Error('Another mail-to-code controller is running');
        }
        catch (check) {
            if ((check as NodeJS.ErrnoException).code !== 'ESRCH')
                throw check;
        }
        await unlink(path);
        await create();
    }
    let released = false;
    return async () => { if (released)
        return; const owner = JSON.parse(await readFile(path, 'utf8')); if (owner.pid === process.pid)
        await unlink(path); released = true; };
}
