import path from 'node:path';
import { VpsServer } from './server';

async function main(): Promise<void> {
  let agentTokens: Record<string, string>;
  try {
    const raw: unknown = JSON.parse(process.env.PAIR_VPS_AGENT_TOKENS ?? '{}');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error();
    agentTokens = raw as Record<string, string>;
  } catch { throw new Error('PAIR_VPS_AGENT_TOKENS must be a JSON object mapping agent IDs to their tokens.'); }
  const port = Number(process.env.PAIR_VPS_PORT ?? '8787');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PAIR_VPS_PORT.');
  const server = new VpsServer({
    clientToken: process.env.PAIR_VPS_CLIENT_TOKEN ?? '', agentTokens,
    dataDirectory: path.resolve(process.env.PAIR_VPS_DATA ?? './.pair-vps'),
  });
  await server.start(port, process.env.PAIR_VPS_BIND ?? '127.0.0.1');
  console.log(`Pair Notebook VPS service is listening on port ${port}.`);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void server.stop().then(() => process.exit(0), () => process.exit(1));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

void main().catch(() => {
  console.error('VPS service could not start. Check tokens, port and the writable job data directory.');
  process.exitCode = 1;
});
