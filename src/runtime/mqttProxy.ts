import { type IClientOptions } from 'mqtt';
import { createProxiedNodeWebSocket } from './proxyWebSocket';

type MqttSocketFactory = (url: string, protocols: string[]) => unknown;

/** Adds MQTT.js' own WebSocket hook without replacing an explicit caller hook. */
export function proxyAwareMqttOptions(
  options: IClientOptions = {},
  socketFactory: MqttSocketFactory = createProxiedNodeWebSocket,
): IClientOptions {
  if (options.createWebsocket) return options;
  return {
    ...options,
    createWebsocket: (url, protocols) => socketFactory(url, protocols),
  };
}
