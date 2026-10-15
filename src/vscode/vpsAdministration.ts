import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { PersistentClient, PersistentHttpError } from '../vps/persistentClient';
import type { PersistentSessionView } from '../vps/persistentProtocol';
import { sessionResources, type SessionResources } from '../vps/sessionSettings';

export async function administrativeToken(context: vscode.ExtensionContext, endpoint: string): Promise<string | undefined> {
  const key = `pairNotebook.vpsAdministrator.${createHash('sha256').update(endpoint).digest('hex')}`;
  const verify = async (token: string): Promise<void> => {
    const result = await new PersistentClient(endpoint, { kind: 'admin', token }).call<{ capabilities?: { sessionAdministration?: number } }>('list');
    if (result.capabilities?.sessionAdministration !== 1) throw new Error('Update the Pair Notebook VPS server to 0.6.4 before creating sessions with folder isolation and resource allocations. Existing sessions can still reconnect.');
  };
  const stored = await context.secrets.get(key);
  if (stored) {
    try { await verify(stored); return stored; }
    catch (error) { if (!(error instanceof PersistentHttpError) || error.status !== 401) throw error; await context.secrets.delete(key); }
  }
  const token = await vscode.window.showInputBox({ title: 'VPS administrator', password: true, ignoreFocusOut: true,
    prompt: 'Administrative token for this VPS', validateInput: (value) => /^[A-Za-z0-9_-]{32,256}$/.test(value) ? undefined : 'Enter the configured administrative token.' });
  if (token !== undefined) { await verify(token); await context.secrets.store(key, token); }
  return token;
}

export async function resourceAllocation(current?: SessionResources): Promise<SessionResources | undefined> {
  const value = await vscode.window.showInputBox({ title: 'Session resource allocation', ignoreFocusOut: true,
    prompt: 'Current project contents in MiB, maximum queued/running executions. CPU/RAM are bounded by the isolated worker service.',
    value: `${current?.storageMb ?? 128}, ${current?.activeExecutions ?? 32}`,
    validateInput: (text) => { try { const [storageMb, activeExecutions] = text.split(',').map(Number); sessionResources({ storageMb, activeExecutions }); return undefined; } catch (error) { return (error as Error).message; } } });
  if (value === undefined) return undefined;
  const [storageMb, activeExecutions] = value.split(',').map(Number);
  return sessionResources({ storageMb, activeExecutions });
}

export async function manageVpsServer(context: vscode.ExtensionContext, endpoint: string): Promise<void> {
  const token = await administrativeToken(context, endpoint);
  if (!token) return;
  const client = new PersistentClient(endpoint, { kind: 'admin', token });
  const list = await client.call<{ sessions: { id: string; name: string; state: string; mode: string; projectRoot: string }[] }>('list');
  if (!list.sessions.length) { await vscode.window.showInformationMessage('No VPS sessions. Use Create persistent VPS session or Create temporary VPS session.'); return; }
  const selected = await vscode.window.showQuickPick(list.sessions.map((session) => ({ label: session.name, description: `${session.mode} · ${session.state} · ${session.projectRoot}`, session })), { title: 'VPS administration · sessions' });
  if (!selected) return;
  const sessionId = selected.session.id;
  const call = <T>(fields: Record<string, unknown>) => client.call<T>('adminSession', { sessionId, ...fields });
  const view = await call<PersistentSessionView>({ action: 'view' });
  const action = await vscode.window.showQuickPick([
    { label: 'Session resources', action: 'manageResources' }, { label: 'Kick participant', action: 'kick' },
    { label: 'Block participant', action: 'ban' }, { label: 'Unblock participant', action: 'unban' },
    { label: view.state === 'running' ? 'Stop session' : 'Start session', action: 'lifecycle' },
  ], { title: `VPS · ${view.name} · ${view.projectRoot}` });
  if (!action) return;
  if (action.action === 'manageResources') {
    const resources = await resourceAllocation(view.resources);
    if (resources) await call({ action: action.action, resources });
  } else if (action.action === 'unban') {
    const name = await vscode.window.showQuickPick(view.bannedNames ?? [], { title: 'Unblock participant name' });
    if (name) await call({ action: action.action, name });
  } else if (action.action === 'lifecycle') {
    const lifecycle = view.state === 'running' ? 'stop' : 'start';
    const confirmed = await vscode.window.showWarningMessage(`${action.label}: ${view.name}?`, { modal: true }, action.label);
    if (confirmed) await call({ action: 'lifecycle', lifecycle });
  } else {
    const member = await vscode.window.showQuickPick(view.members.filter((member) => member.id !== view.ownerId).map((member) => ({ label: member.name, memberId: member.id })), { title: action.action === 'ban' ? 'Block this identity and participant name. Rotate the password to prevent new identities.' : 'Kick participant; joining again remains possible.' });
    if (member) await call({ action: action.action, memberId: member.memberId });
  }
}
