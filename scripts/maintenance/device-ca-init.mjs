import { resolve } from 'node:path';
import { createDeviceCertificateAuthority } from '../../services/central-gateway/dist/device-certificates.js';

// Run on the central operator host; the destination must not exist.
// No private key is accepted through arguments, stdin, environment, or stdout.
try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--directory' || !args[1]) throw Error('Usage: node scripts/maintenance/device-ca-init.mjs --directory /absolute/private/device-ca');
  const result = await createDeviceCertificateAuthority({ directory: resolve(args[1]) });
  process.stdout.write(JSON.stringify({ created: true, configFile: result.configFile }) + '\n');
} catch (error) {
  process.stderr.write((error instanceof Error && (/^DEVICE_CA_[A-Z_]+$/.test(error.message) || error.message.startsWith('Usage:')) ? error.message : 'DEVICE_CA_INIT_FAILED') + '\n');
  process.exitCode = 1;
}
