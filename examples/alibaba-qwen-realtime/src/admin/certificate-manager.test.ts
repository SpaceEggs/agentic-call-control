import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CertificateManager } from './certificate-manager.ts';

test('certificate status reports missing lego and certificate without starting HTTP', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qwen-cert-'));
    const manager = new CertificateManager({
        domain: 'admin.example.test',
        email: 'admin@example.test',
        legoPath: join(root, 'missing-lego'),
        dataDir: join(root, 'lego'),
    });
    const status = await manager.status();
    assert.equal(status.available, false);
    assert.equal(status.legoAvailable, false);
});
