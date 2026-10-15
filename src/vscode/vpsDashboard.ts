import type { DashboardState } from './dashboard';
import type { PersistentSessionView } from '../vps/persistentProtocol';

const capacity = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;

export function vpsDashboardState(view: PersistentSessionView, connectedAt: number, reconnecting = false): DashboardState {
  const target = view.devices.find((device) => device.id === view.target.deviceId);
  const host = view.host;
  return {
    live: true, persistent: true, isHost: view.memberId === view.ownerId,
    projectName: view.name, mode: view.mode === 'temporary' ? 'Временная VPS-сессия' : 'Постоянная VPS-сессия',
    durationSeconds: Math.max(0, Math.floor((Date.now() - connectedAt) / 1000)), hostName: 'VPS',
    hostDetails: host ? [host.cpu, `RAM: ${capacity(host.memoryFreeBytes)} / ${capacity(host.memoryTotalBytes)} свободно`,
      `Диск: ${capacity(host.diskFreeBytes)} / ${capacity(host.diskTotalBytes)} свободно`].join('\n') : 'Ожидание данных сервера',
    runtimeState: reconnecting ? 'reconnecting' : view.state === 'running' ? 'ready' : 'host-unavailable',
    runtimeDetail: reconnecting ? 'Восстанавливаем HTTPS-подключение к VPS.' : `Проект сохранён на VPS. Папка: ${view.projectRoot ?? view.id}`,
    participants: view.members.map((member) => ({ id: member.id, name: member.name,
      role: member.id === view.ownerId ? 'ВЛАДЕЛЕЦ VPS' : member.role === 'admin' ? 'АДМИНИСТРАТОР' : 'УЧАСТНИК',
      active: '', latency: -1, hardware: '', load: '', online: member.online })),
    compute: { name: target?.id === 'vps' ? 'VPS' : target?.name ?? 'VPS', cpu: target?.cpu ?? host?.cpu ?? '',
      execution: target?.online ? 'Устройство доступно' : 'Вычислитель недоступен', python: target?.python ?? '—',
      kernel: target?.online ? 'Статус ядра не сообщён' : 'Offline', device: view.target.gpuUuid ? 'GPU' : 'CPU' },
    network: { direct: 0, down: 0, up: 0, address: 'HTTPS · сервер VPS' },
  };
}
