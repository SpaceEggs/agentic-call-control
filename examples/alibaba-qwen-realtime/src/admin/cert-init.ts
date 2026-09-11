import appconfig from '../app-config.ts';
import { CertificateManager, assertSecretFilePermissions } from './certificate-manager.ts';

async function main(): Promise<void> {
    if (!appconfig.admin?.tls) throw new Error('admin.tls configuration is missing from config.yaml');
    assertSecretFilePermissions();
    const manager = new CertificateManager(appconfig.admin.tls);
    console.log(`[Certificate] requesting ${appconfig.admin.tls.domain} with lego`);
    const output = await manager.issue(false);
    console.log(output);
    console.log('[Certificate] initialization complete');
}

main().catch((error) => {
    console.error('[Certificate] initialization failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
