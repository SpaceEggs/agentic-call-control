import { EventEmitter } from 'node:events';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { format } from 'node:util';

export interface RuntimeLogEntry {
    id: number;
    timestamp: string;
    level: string;
    message: string;
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');

export class AdminLogHub extends EventEmitter {
    private readonly entries: RuntimeLogEntry[] = [];
    private nextId = 1;
    private installed = false;
    private readonly path: string;
    private readonly limit: number;

    constructor(path = resolve('data/runtime.log'), limit = 2_000) {
        super();
        this.path = path;
        this.limit = limit;
        if (existsSync(this.path)) {
            const lines = readFileSync(this.path, 'utf8').trim().split('\n').slice(-limit);
            for (const line of lines) {
                try {
                    const entry = JSON.parse(line) as RuntimeLogEntry;
                    this.entries.push(entry);
                    this.nextId = Math.max(this.nextId, entry.id + 1);
                } catch {
                    // Ignore a partial final line after an unclean shutdown.
                }
            }
        }
    }

    installConsoleMirror(): void {
        if (this.installed) return;
        this.installed = true;
        for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
            const original = console[level].bind(console);
            console[level] = (...args: unknown[]) => {
                original(...args);
                this.push(level, format(...args).replace(ANSI, ''));
            };
        }
    }

    push(level: string, message: string): void {
        const entry: RuntimeLogEntry = {
            id: this.nextId++,
            timestamp: new Date().toISOString(),
            level,
            message,
        };
        this.entries.push(entry);
        if (this.entries.length > this.limit) this.entries.shift();
        try {
            mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
            appendFileSync(this.path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
            chmodSync(this.path, 0o600);
        } catch {
            // Logging must never interrupt a phone call.
        }
        this.emit('entry', entry);
    }

    list(after = 0): RuntimeLogEntry[] {
        return this.entries.filter((entry) => entry.id > after);
    }
}
