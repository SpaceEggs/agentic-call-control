import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { X509Certificate } from 'node:crypto';
import type { Server as HttpsServer } from 'node:https';
import type { AdminConfig } from '../app-config.ts';

export interface CertificateStatus {
    available: boolean;
    domain: string;
    issuer?: string;
    validFrom?: string;
    validTo?: string;
    daysRemaining?: number;
    fingerprint?: string;
    legoAvailable: boolean;
    legoVersion?: string;
    credentialsConfigured: boolean;
    busy: boolean;
    lastError?: string;
    lastRunAt?: string;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export class CertificateManager extends EventEmitter {
    private busy = false;
    private lastError: string | undefined;
    private lastRunAt: string | undefined;
    private timer: NodeJS.Timeout | undefined;
    private httpsServer: HttpsServer | undefined;
    private readonly dataDir: string;
    private readonly legoPath: string;
    private readonly config: AdminConfig['tls'];

    constructor(config: AdminConfig['tls']) {
        super();
        this.config = config;
        this.dataDir = resolve(config.dataDir ?? 'data/lego');
        this.legoPath = resolve(config.legoPath ?? '/usr/local/bin/lego');
    }

    private certificateName(): string {
        return this.config.domain.startsWith('*.') ? `_.${this.config.domain.slice(2)}` : this.config.domain;
    }

    private certificatePath(dataDir = this.dataDir): string {
        return resolve(dataDir, 'certificates', `${this.certificateName()}.crt`);
    }

    private keyPath(dataDir = this.dataDir): string {
        return resolve(dataDir, 'certificates', `${this.certificateName()}.key`);
    }

    credentialsConfigured(): boolean {
        const access = process.env.ALICLOUD_ACCESS_KEY_FILE;
        const secret = process.env.ALICLOUD_SECRET_KEY_FILE;
        return Boolean(access && secret && existsSync(access) && existsSync(secret));
    }

    hasCertificate(): boolean {
        return existsSync(this.certificatePath()) && existsSync(this.keyPath());
    }

    tlsOptions(): { cert: Buffer; key: Buffer } {
        if (!this.hasCertificate()) {
            throw new Error('Admin TLS certificate is missing; run yarn cert:init:qwenalibaba first');
        }
        return {
            cert: readFileSync(this.certificatePath()),
            key: readFileSync(this.keyPath()),
        };
    }

    attach(server: HttpsServer): void {
        this.httpsServer = server;
    }

    private async legoVersion(): Promise<string | undefined> {
        if (!existsSync(this.legoPath)) return undefined;
        try {
            const output = await this.runProcess(['--version'], 30_000);
            return output.trim().split('\n')[0];
        } catch {
            return undefined;
        }
    }

    async status(): Promise<CertificateStatus> {
        const version = await this.legoVersion();
        const status: CertificateStatus = {
            available: this.hasCertificate(),
            domain: this.config.domain,
            legoAvailable: Boolean(version),
            legoVersion: version,
            credentialsConfigured: this.credentialsConfigured(),
            busy: this.busy,
            lastError: this.lastError,
            lastRunAt: this.lastRunAt,
        };
        if (!status.available) return status;
        try {
            const cert = new X509Certificate(readFileSync(this.certificatePath()));
            status.issuer = cert.issuer;
            status.validFrom = new Date(cert.validFrom).toISOString();
            status.validTo = new Date(cert.validTo).toISOString();
            status.daysRemaining = Math.ceil((new Date(cert.validTo).getTime() - Date.now()) / 86_400_000);
            status.fingerprint = cert.fingerprint256;
        } catch (error) {
            status.lastError = messageOf(error);
        }
        return status;
    }

    async issue(staging = false): Promise<string> {
        if (this.busy) throw new Error('A certificate operation is already running');
        if (!this.credentialsConfigured()) {
            throw new Error('ALICLOUD_ACCESS_KEY_FILE and ALICLOUD_SECRET_KEY_FILE are required');
        }
        const expected = this.config.legoVersion ?? '5.0.4';
        const installed = await this.legoVersion();
        if (!installed) throw new Error(`lego was not found at ${this.legoPath}`);
        if (!installed.includes(expected)) throw new Error(`Expected lego ${expected}, found ${installed}`);

        this.busy = true;
        this.lastError = undefined;
        this.emit('changed');
        const targetDir = staging ? `${this.dataDir}-staging` : this.dataDir;
        const args = [
            '--path', targetDir,
            '--email', this.config.email,
            '--accept-tos',
            '--dns', 'alidns',
            '--domains', this.config.domain,
        ];
        if (this.config.dnsResolvers?.length) {
            for (const resolver of this.config.dnsResolvers) args.push('--dns.resolvers', resolver);
        }
        if (staging) args.push('--server', 'https://acme-staging-v02.api.letsencrypt.org/directory');
        args.push('run');
        try {
            const output = await this.runProcess(args, 15 * 60_000);
            this.lastRunAt = new Date().toISOString();
            if (!staging && this.httpsServer) this.httpsServer.setSecureContext(this.tlsOptions());
            return output;
        } catch (error) {
            this.lastError = messageOf(error);
            throw error;
        } finally {
            this.busy = false;
            this.emit('changed');
        }
    }

    async renew(): Promise<string> {
        return this.issue(false);
    }

    startScheduler(): void {
        const hours = this.config.renewCheckHours ?? 12;
        this.timer = setInterval(() => {
            void this.renew().catch((error) => {
                this.lastError = messageOf(error);
                this.emit('changed');
            });
        }, Math.max(1, hours) * 3_600_000);
        this.timer.unref();
    }

    stopScheduler(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
    }

    private runProcess(args: string[], timeoutMs: number): Promise<string> {
        return new Promise((resolveOutput, rejectOutput) => {
            const child = spawn(this.legoPath, args, {
                shell: false,
                env: process.env,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let output = '';
            const append = (chunk: Buffer): void => {
                output += chunk.toString('utf8');
                if (output.length > 500_000) output = output.slice(-500_000);
            };
            child.stdout.on('data', append);
            child.stderr.on('data', append);
            const timer = setTimeout(() => {
                child.kill('SIGTERM');
                rejectOutput(new Error('lego operation timed out'));
            }, timeoutMs);
            child.once('error', (error) => {
                clearTimeout(timer);
                rejectOutput(error);
            });
            child.once('close', (code) => {
                clearTimeout(timer);
                if (code === 0) resolveOutput(output);
                else rejectOutput(new Error(`lego exited with code ${code}: ${output.trim()}`));
            });
        });
    }
}

export function assertSecretFilePermissions(): void {
    for (const key of ['ALICLOUD_ACCESS_KEY_FILE', 'ALICLOUD_SECRET_KEY_FILE'] as const) {
        const path = process.env[key];
        if (!path || !existsSync(path)) continue;
        const mode = statSync(path).mode & 0o777;
        if ((mode & 0o077) !== 0) throw new Error(`${key} must reference a file with mode 0600`);
    }
}
