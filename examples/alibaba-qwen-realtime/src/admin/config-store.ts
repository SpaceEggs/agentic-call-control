import { createHash } from 'node:crypto';
import {
    chmodSync,
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { CustomMcpServerConfig } from '@3cx-examples/mcp';

interface AdminState {
    revision: number;
    customMcpServers: StoredMcpServer[];
}

type StoredMcpServer = Omit<CustomMcpServerConfig, 'auth'> & {
    auth?: { type: 'none' | 'oauth' | 'bearer' };
};

export type AdminMcpServerInput = Omit<CustomMcpServerConfig, 'auth'> & {
    auth?: { type: 'none' | 'oauth' | 'bearer'; token?: string };
};

function stableId(name: string): string {
    const slug = name.trim().replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^_+|_+$/g, '') || 'mcp';
    return `${slug}-${createHash('sha256').update(name).digest('hex').slice(0, 8)}`;
}

function atomicJson(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
    chmodSync(path, 0o600);
}

function validateUrl(value: string): string {
    const url = new URL(value.trim());
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('MCP URL must use http or https');
    return url.toString();
}

export class AdminConfigStore {
    private state: AdminState;
    private readonly statePath: string;
    private readonly secretDir: string;
    private readonly publicBaseUrl?: string;

    constructor(
        baseServers: CustomMcpServerConfig[] = [],
        stateFile = 'data/admin-state.json',
        publicBaseUrl?: string,
    ) {
        this.publicBaseUrl = publicBaseUrl;
        this.statePath = resolve(stateFile);
        this.secretDir = resolve(dirname(this.statePath), 'secrets/mcp');
        this.state = this.readState(baseServers);
        for (const server of baseServers) {
            if (server.auth?.type !== 'bearer' || !server.auth.token) continue;
            const id = server.id ?? stableId(server.name);
            if (!existsSync(this.secretPath(id))) atomicJson(this.secretPath(id), { token: server.auth.token });
        }
    }

    private readState(baseServers: CustomMcpServerConfig[]): AdminState {
        if (existsSync(this.statePath)) {
            const parsed = JSON.parse(readFileSync(this.statePath, 'utf8')) as AdminState;
            return {
                revision: Number(parsed.revision) || 1,
                customMcpServers: parsed.customMcpServers ?? [],
            };
        }
        return {
            revision: 1,
            customMcpServers: baseServers.map((server) => ({
                ...server,
                id: server.id ?? stableId(server.name),
                auth: server.auth ? { type: server.auth.type } : { type: 'none' },
            })),
        };
    }

    private secretPath(id: string): string {
        return resolve(this.secretDir, `${id.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`);
    }

    private readBearer(id: string): string | undefined {
        try {
            const value = JSON.parse(readFileSync(this.secretPath(id), 'utf8')) as { token?: string };
            return value.token;
        } catch {
            return undefined;
        }
    }

    get revision(): number {
        return this.state.revision;
    }

    getServers(): CustomMcpServerConfig[] {
        const callback = this.publicBaseUrl
            ? new URL('/api/mcp/oauth/callback', this.publicBaseUrl).toString()
            : undefined;
        return this.state.customMcpServers.map((server) => {
            const id = server.id ?? stableId(server.name);
            if (!/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error(`Invalid MCP id: ${id}`);
            let auth: CustomMcpServerConfig['auth'];
            if (server.auth?.type === 'oauth') {
                auth = {
                    type: 'oauth',
                    redirectUrl: callback,
                    tokenFile: resolve(this.secretDir, `${id}.oauth.json`),
                    openBrowser: false,
                };
            } else if (server.auth?.type === 'bearer') {
                auth = { type: 'bearer', token: this.readBearer(id) ?? '' };
            } else {
                auth = { type: 'none' };
            }
            return {
                ...server,
                id,
                url: validateUrl(server.url),
                auth,
                mcpRemote: server.transport === 'mcp-remote'
                    ? {
                        ...server.mcpRemote,
                        configDir: resolve(dirname(this.statePath), 'mcp-remote', id),
                    }
                    : server.mcpRemote,
            };
        });
    }

    saveServers(inputs: AdminMcpServerInput[], expectedRevision: number): CustomMcpServerConfig[] {
        if (expectedRevision !== this.state.revision) throw new Error('Configuration changed; reload and try again');
        const ids = new Set<string>();
        const stored = inputs.map((input): StoredMcpServer => {
            const name = input.name.trim();
            if (!name) throw new Error('MCP name is required');
            const id = input.id ?? stableId(name);
            if (!/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error(`Invalid MCP id: ${id}`);
            if (ids.has(id)) throw new Error(`Duplicate MCP id: ${id}`);
            ids.add(id);
            const authType = input.auth?.type ?? 'none';
            if (authType === 'bearer' && input.auth?.token) {
                atomicJson(this.secretPath(id), { token: input.auth.token });
            }
            if (authType === 'bearer' && !input.auth?.token && !this.readBearer(id)) {
                throw new Error(`Bearer token is required for ${name}`);
            }
            return {
                ...input,
                id,
                name,
                url: validateUrl(input.url),
                auth: { type: authType },
            };
        });
        this.state = { revision: this.state.revision + 1, customMcpServers: stored };
        atomicJson(this.statePath, this.state);
        return this.getServers();
    }
}
