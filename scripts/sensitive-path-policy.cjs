/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const path = require('node:path');

const SENSITIVE_DIRECTORIES = new Set([
  '.ssh', '.aws', '.azure', '.gnupg', '.docker', '.kube', '.terraform', '.pulumi',
]);
const SENSITIVE_FILE_NAMES = new Set([
  '.envrc', '.npmrc', '.pypirc', '.netrc', '_netrc', '.git-credentials',
  '.pgpass', 'pgpass.conf', '.my.cnf', '.mylogin.cnf', '.authinfo',
  'credentials.json', 'service-account.json', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
  'application_default_credentials.json', 'client_secret.json', 'client_secrets.json',
  'terraform.tfstate', 'terraform.tfstate.backup', 'kubeconfig',
]);
const SENSITIVE_PATH_SUFFIXES = [
  '.cargo/credentials', '.cargo/credentials.toml',
  '.config/gh/hosts.yml', 'github cli/hosts.yml',
];
const SENSITIVE_EXTENSIONS = new Set([
  '.pem', '.p12', '.pfx', '.key', '.keystore', '.jks', '.ppk', '.mobileprovision',
  '.ovpn', '.tfstate', '.tfvars', '.kubeconfig',
]);
const SAFE_ENV_FILES = new Set(['.env.example', '.env.sample', '.env.template']);

function isSensitiveFileName(lowerName) {
  return (lowerName === '.env' || (lowerName.startsWith('.env.') && !SAFE_ENV_FILES.has(lowerName)))
    || SENSITIVE_FILE_NAMES.has(lowerName)
    || SENSITIVE_EXTENSIONS.has(path.extname(lowerName))
    || lowerName.endsWith('.tfstate.backup')
    || lowerName.endsWith('.tfvars.json')
    || /^client_secret(?:_.+)?\.json$/.test(lowerName);
}

function isSensitiveArtifactPath(relativePath) {
  const segments = relativePath.replaceAll('\\', '/').split('/').filter(Boolean)
    .map((segment) => segment.toLowerCase());
  const lowerName = segments.at(-1) ?? '';
  const lowerPath = segments.join('/');
  return segments.some((segment) => SENSITIVE_DIRECTORIES.has(segment))
    || isSensitiveFileName(lowerName)
    || SENSITIVE_PATH_SUFFIXES.some((suffix) => lowerPath === suffix || lowerPath.endsWith(`/${suffix}`));
}

module.exports = { isSensitiveArtifactPath };
