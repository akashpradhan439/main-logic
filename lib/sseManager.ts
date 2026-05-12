export type BufferItem = { eventId: string; data: unknown };

export type ConnectionState = {
  send: (event: string, data: unknown, id?: string) => boolean;
  buffer: BufferItem[];
  isLive: boolean;
};

const connections = new Map<string, ConnectionState>();

export function registerConnection(userId: string, state: ConnectionState): void {
  connections.set(userId, state);
}

export function removeConnection(userId: string): void {
  connections.delete(userId);
}

export function getConnection(userId: string): ConnectionState | undefined {
  return connections.get(userId);
}

export function isConnected(userId: string): boolean {
  return connections.has(userId);
}
