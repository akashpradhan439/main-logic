import type { FastifyReply } from "fastify";

/**
 * Manages Server-Sent Events (SSE) connections for users.
 */
export class SSEManager {
  private clients = new Map<string, Set<FastifyReply>>();

  /**
   * Adds a new SSE connection for a user.
   */
  addClient(userId: string, reply: FastifyReply) {
    if (!this.clients.has(userId)) {
      this.clients.set(userId, new Set());
    }
    this.clients.get(userId)!.add(reply);

    // Initial SSE headers
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    // Keep-alive ping
    const keepAlive = setInterval(() => {
      reply.raw.write(":\n\n");
    }, 30000);

    reply.raw.on("close", () => {
      clearInterval(keepAlive);
      this.removeClient(userId, reply);
    });
  }

  /**
   * Removes an SSE connection for a user.
   */
  removeClient(userId: string, reply: FastifyReply) {
    const userClients = this.clients.get(userId);
    if (userClients) {
      userClients.delete(reply);
      if (userClients.size === 0) {
        this.clients.delete(userId);
      }
    }
  }

  /**
   * Broadcasts an event to all connected sessions for a specific user.
   */
  notifyUser(userId: string, data: object) {
    const userClients = this.clients.get(userId);
    if (userClients) {
      const payload = `data: ${JSON.stringify(data)}\n\n`;
      for (const reply of userClients) {
        reply.raw.write(payload);
      }
    }
  }

  /**
   * Broadcasts an event to multiple users.
   */
  notifyUsers(userIds: string[], data: object) {
    for (const userId of userIds) {
      this.notifyUser(userId, data);
    }
  }
}
