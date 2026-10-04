import { readdirSync, realpathSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Config } from './config.js';
// Directory links deliberately installed by the operator are project locations,
// not textual aliases. Authorization always binds the canonical Git identity.
export function projectLocations(config: Config) {
    const locations: {
        entry: string;
        path: string;
    }[] = [];
    for (const entry of readdirSync(config.projectsRoot, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || !entry.isDirectory() && !entry.isSymbolicLink())
            continue;
        const path = join(config.projectsRoot, entry.name);
        let actual: string;
        try {
            actual = realpathSync(path);
        }
        catch {
            continue;
        }
        if (existsSync(join(actual, '.git')))
            locations.push({ entry: path, path: actual });
    }
    for (const repo of Object.values(config.repositories)) {
        let path: string;
        try {
            path = realpathSync(repo.path);
        }
        catch {
            continue;
        }
        if (!locations.some(p => p.path === path))
            locations.push({ entry: resolve(repo.path), path });
    }
    return locations;
}
