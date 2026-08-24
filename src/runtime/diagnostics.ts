/**
 * Passive network diagnostics for Pair Notebook.
 *
 * Everything in this module runs with ordinary user permissions and never
 * modifies system state. Each conclusion carries an explicit confidence level
 * so the UI can separate facts (a SOCKS proxy is configured) from inference
 * (UDP appears unavailable because every UDP TURN probe failed while TCP/TLS
 * succeeded). Speculation must be labelled as speculation: a VPN/TUN adapter
 * being present is reported as a possible contributor, never as proof that
 * it blocks WebRTC.
 *
 * Credentials are never included anywhere in this report; proxy descriptions
 * come from `describeProxy`, which redacts userinfo.
 */

import { networkInterfaces } from 'node:os';
import { describeProxy, resolveProxy } from './proxy';
import type { ProxyWebSocketRuntimeOptions } from './proxyWebSocket';
import type { TurnProbeResult } from './turn';

export type DiagnosticConfidence = 'confirmed' | 'high' | 'medium' | 'low';

export interface DiagnosticObservation {
  /** What was directly observed, phrased as evidence. */
  observation: string;
  /** The likely impact on Pair Notebook connectivity, if any. */
  impact: string;
  confidence: DiagnosticConfidence;
  /** Candidate explanations when the evidence cannot distinguish them. */
  possibleCauses?: string[];
  /** Optional user action; never "disable your security software". */
  suggestion?: string;
}

export interface UdpAvailability {
  state: 'available' | 'unavailable' | 'unknown';
  confidence: DiagnosticConfidence;
  detail: string;
}

export interface AdapterObservation {
  name: string;
  kind: 'vpn-tun' | 'virtual' | 'physical' | 'other';
  hasIp: boolean;
}

/** Name fragments that indicate TUN/TAP-style virtual or VPN adapters. */
const VPN_TUN_ADAPTER_PATTERNS = [
  'tun', 'tap', 'wireguard', 'wg', 'openvpn', 'tailscale', 'zerotier',
  'nordlynx', 'protonwire', 'amneziawg', 'awg', 'outline', 'sing-box',
  'karing', 'happ', 'clash', 'mihomo', 'v2ray', 'xray', 'utun',
];

const KNOWN_VIRTUAL_ADAPTERS = [
  'vmware', 'virtualbox', 'hyper-v', 'vethernet', 'docker', 'wsl', 'loopback',
  'bluetooth', 'microsoft wi-fi direct',
];

/**
 * Classifies network adapters using only `os.networkInterfaces()`. Windows
 * adapter names such as "TAP-Windows Adapter V9" or "WireGuard Tunnel"
 * surface here without any privileged API.
 */
export function classifyAdapters(
  list: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): AdapterObservation[] {
  const result: AdapterObservation[] = [];
  for (const [name, addresses] of Object.entries(list)) {
    const lowered = name.toLowerCase();
    const hasIp = (addresses ?? []).some((address) => !address.internal);
    let kind: AdapterObservation['kind'] = 'physical';
    if (VPN_TUN_ADAPTER_PATTERNS.some((pattern) => lowered.includes(pattern))) kind = 'vpn-tun';
    else if (KNOWN_VIRTUAL_ADAPTERS.some((pattern) => lowered.includes(pattern))) kind = 'virtual';
    else if (!hasIp) kind = 'other';
    result.push({ name, kind, hasIp });
  }
  return result;
}

/**
 * Infers local UDP reachability from live TURN Allocate probes. All UDP
 * probes failing while at least one TCP/TLS probe succeeds is strong
 * evidence of filtered UDP; anything else stays "unknown" rather than
 * guessed.
 */
export function assessUdpAvailability(probes: readonly TurnProbeResult[]): UdpAvailability {
  const udp = probes.filter((probe) => probe.endpoint.transport === 'udp');
  const nonUdp = probes.filter((probe) => probe.endpoint.transport !== 'udp');
  if (udp.length === 0) return { state: 'unknown', confidence: 'low', detail: 'UDP TURN probes were not run.' };
  if (udp.every((probe) => probe.ok)) {
    return { state: 'available', confidence: 'high', detail: 'TURN UDP Allocate succeeded.' };
  }
  if (nonUdp.some((probe) => probe.ok)) {
    return {
      state: 'unavailable',
      confidence: 'high',
      detail: 'All UDP TURN probes failed while TCP/TLS paths succeeded.',
    };
  }
  return { state: 'unavailable', confidence: 'medium', detail: 'All TURN transports failed, including UDP.' };
}

export interface DiagnosticsInput {
  turnProbes?: readonly TurnProbeResult[];
  relayFallbackEnabled?: boolean;
  connectedRelayCount?: number;
  /** Hosts to check for DNS resolution; failures are reported per host. */
  dnsHosts?: readonly string[];
  resolveDns?(host: string): Promise<{ address: string }>;
  proxyOptions?: ProxyWebSocketRuntimeOptions;
  /** Test seam for adapter classification. */
  adapters?: readonly AdapterObservation[];
}

export interface NetworkDiagnosticsReport {
  observations: DiagnosticObservation[];
  udp: UdpAvailability;
  proxy: string;
  vpnTunDetected: boolean;
  dnsFailures: string[];
}

const DEFAULT_DNS_HOSTS = ['nos.lol', 'relay.damus.io', 'openrelay.metered.ca'];

/**
 * Builds the full passive report. DNS checks are bounded and optional; when
 * no resolver is injected the check is skipped rather than guessed.
 */
export async function buildNetworkDiagnostics(input: DiagnosticsInput = {}): Promise<NetworkDiagnosticsReport> {
  const observations: DiagnosticObservation[] = [];
  const adapters = input.adapters ?? classifyAdapters();
  const vpnAdapters = adapters.filter((adapter) => adapter.kind === 'vpn-tun' && adapter.hasIp);
  const vpnTunDetected = vpnAdapters.length > 0;

  const udp = assessUdpAvailability(input.turnProbes ?? []);
  if (udp.state === 'unavailable') {
    observations.push({
      observation: udp.detail,
      impact: 'UDP appears unavailable on the current network path; WebRTC falls back to TCP/TLS relaying.',
      confidence: udp.confidence,
      possibleCauses: ['VPN routing', 'Firewall', 'ISP filtering', 'Packet-filter configuration'],
    });
  }

  if (vpnTunDetected) {
    observations.push({
      observation: `A VPN/TUN adapter is active (${vpnAdapters.map((adapter) => adapter.name).join(', ')}).`,
      impact: 'Direct peer candidates may be routed through the VPN instead of the physical interface.',
      confidence: 'medium',
      possibleCauses: ['Full-tunnel VPN routing', 'Split-tunnel configuration'],
    });
  }

  const proxyTarget = 'wss://nos.lol';
  const proxy = describeProxy(resolveProxy(proxyTarget, input.proxyOptions ?? {}));
  if (proxy !== 'Direct') {
    observations.push({
      observation: `${proxy} is configured.`,
      impact: 'Signalling and emergency-relay sockets are routed through this proxy.',
      confidence: 'confirmed',
    });
  }

  const dnsFailures: string[] = [];
  if (input.resolveDns) {
    const hosts = input.dnsHosts ?? DEFAULT_DNS_HOSTS;
    await Promise.all(hosts.map(async (host) => {
      try {
        await input.resolveDns!(host);
      } catch {
        dnsFailures.push(host);
      }
    }));
    if (dnsFailures.length > 0) {
      observations.push({
        observation: `DNS resolution failed for ${dnsFailures.length} of ${hosts.length} signalling hosts.`,
        impact: 'Discovery may stall until resolution recovers.',
        confidence: 'confirmed',
        possibleCauses: ['Custom DNS settings', 'DNS-over-HTTPS/TLS outage', 'Domain filtering'],
      });
    }
  }

  if (input.relayFallbackEnabled && (input.connectedRelayCount ?? 0) === 0 && (input.turnProbes?.length ?? 0) > 0) {
    // Only meaningful once probes have actually been attempted.
    observations.push({
      observation: 'No emergency-relay socket is currently connected.',
      impact: 'The last-resort encrypted Nostr transport is not available right now.',
      confidence: 'confirmed',
      possibleCauses: ['Nostr relays unreachable', 'Proxy blocking WSS', 'DNS resolution failure'],
    });
  }

  return { observations, udp, proxy, vpnTunDetected, dnsFailures };
}

