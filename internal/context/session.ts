import { RoleUser, type Message } from "../schema/message.js";

export class Session {
  private readonly history: Message[] = [];
  private readonly creationTime: Date;
  private lastUpdatedAt: Date;

  constructor(
    readonly id: string,
    readonly workDir: string,
    now = new Date(),
  ) {
    this.creationTime = new Date(now.getTime());
    this.lastUpdatedAt = new Date(now.getTime());
  }

  get createdAt(): Date {
    return new Date(this.creationTime.getTime());
  }

  get updatedAt(): Date {
    return new Date(this.lastUpdatedAt.getTime());
  }

  append(message: Message): void {
    this.history.push(structuredClone(message));
    this.lastUpdatedAt = new Date();
  }

  getWorkingMemory(limit: number): Message[] {
    let start = limit > 0 ? Math.max(this.history.length - limit, 0) : 0;

    while (start < this.history.length) {
      const firstMessage = this.history[start];
      if (firstMessage?.role !== RoleUser || firstMessage.toolCallId === undefined) break;
      start += 1;
    }

    return this.history.slice(start).map((message) => structuredClone(message));
  }
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();

  getOrCreate(id: string, workDir: string): Session {
    let session = this.sessions.get(id);
    if (!session) {
      session = new Session(id, workDir);
      this.sessions.set(id, session);
    }
    return session;
  }
}

export const GlobalSessionMgr = new SessionManager();
