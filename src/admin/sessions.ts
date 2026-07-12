import { randomBytes as secureRandomBytes, timingSafeEqual } from "node:crypto";

const SESSION_COOKIE = "codex_admin_session";
const SESSION_IDLE_MS = 30 * 60 * 1000;

export interface AdminSession {
  id: string;
  csrfToken: string;
}

interface StoredSession extends AdminSession {
  lastSeen: number;
}

interface SessionStoreOptions {
  now?: () => number;
  randomBytes?: (size: number) => Uint8Array;
}

export class SessionStore {
  readonly #sessions = new Map<string, StoredSession>();
  readonly #now: () => number;
  readonly #randomBytes: (size: number) => Uint8Array;

  constructor(options: SessionStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#randomBytes = options.randomBytes ?? secureRandomBytes;
  }

  open(cookieHeader: string | undefined): {
    session: AdminSession;
    created: boolean;
  } {
    this.prune();
    const id = sessionIdFrom(cookieHeader);
    const existing = id ? this.#sessions.get(id) : undefined;
    if (existing) {
      existing.lastSeen = this.#now();
      return { session: publicSession(existing), created: false };
    }
    return { session: this.create(), created: true };
  }

  authenticate(
    cookieHeader: string | undefined,
    csrfToken: string | undefined,
  ): AdminSession | undefined {
    this.prune();
    const id = sessionIdFrom(cookieHeader);
    const session = id ? this.#sessions.get(id) : undefined;
    if (!session || !csrfToken || !equalToken(session.csrfToken, csrfToken)) {
      return undefined;
    }
    session.lastSeen = this.#now();
    return publicSession(session);
  }

  rotate(id: string): AdminSession {
    this.#sessions.delete(id);
    return this.create();
  }

  size(): number {
    this.prune();
    return this.#sessions.size;
  }

  private create(): AdminSession {
    const session: StoredSession = {
      id: token(this.#randomBytes),
      csrfToken: token(this.#randomBytes),
      lastSeen: this.#now(),
    };
    this.#sessions.set(session.id, session);
    return publicSession(session);
  }

  private prune(): void {
    const now = this.#now();
    for (const [id, session] of this.#sessions) {
      if (now - session.lastSeen >= SESSION_IDLE_MS) this.#sessions.delete(id);
    }
  }
}

export function sessionCookie(id: string): string {
  return `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict`;
}

function token(randomBytes: (size: number) => Uint8Array): string {
  return Buffer.from(randomBytes(32)).toString("base64url");
}

function publicSession(session: StoredSession): AdminSession {
  return { id: session.id, csrfToken: session.csrfToken };
}

function sessionIdFrom(cookieHeader: string | undefined): string | undefined {
  for (const part of cookieHeader?.split(";") ?? []) {
    const [name, ...value] = part.trim().split("=");
    if (name === SESSION_COOKIE) return value.join("=");
  }
  return undefined;
}

function equalToken(expected: string, received: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(received);
  return left.length === right.length && timingSafeEqual(left, right);
}
