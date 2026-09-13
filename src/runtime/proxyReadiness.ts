import { connect } from 'node:net';
import { describeProxy, resolveProxy, type ProxyResolutionInput } from './proxy';

/** Check the selected endpoint without credentials, requests or routing changes. */
export async function assertProxyReachable(options: ProxyResolutionInput, timeoutMs = 3_000): Promise<void> {
  const proxy = resolveProxy('wss://nos.lol', options);
  if (!proxy) return;
  await new Promise<void>((resolve, reject) => {
    const socket = connect({ host: proxy.host, port: proxy.port });
    const fail = (reason: string) => {
      socket.destroy();
      reject(new Error(`Configured proxy ${describeProxy(proxy)} is unavailable (${reason}). `
        + 'Start that proxy or correct the VS Code/Pair Notebook proxy settings. '
        + 'If your VPN uses TUN, remove the obsolete proxy override explicitly.'));
    };
    socket.setTimeout(timeoutMs, () => fail('timeout'));
    socket.once('error', (error: NodeJS.ErrnoException) => fail(error.code ?? 'connection failed'));
    socket.once('connect', () => { socket.destroy(); resolve(); });
  });
}
