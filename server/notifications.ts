import { newLocalId, type JsonFile } from "./lib/jsonFile.ts";
import type { EventBus } from "./events.ts";

export type NotificationLevel = "info" | "success" | "warn" | "error";

export interface AppNotification {
  id: string;
  at: string;
  title: string;
  body: string;
  level: NotificationLevel;
  /** In-app route to open, e.g. "#/needs-you". */
  link: string | null;
  read: boolean;
}

export class Notifications {
  private items: AppNotification[];
  constructor(
    private readonly store: JsonFile<AppNotification[]>,
    private readonly bus: EventBus,
    private readonly cap = 200,
  ) {
    this.items = store.read();
  }

  add(n: { title: string; body: string; level?: NotificationLevel; link?: string | null }): AppNotification {
    const item: AppNotification = { id: newLocalId("NTF"), at: new Date().toISOString(), title: n.title, body: n.body, level: n.level ?? "info", link: n.link ?? null, read: false };
    this.items.unshift(item);
    this.items = this.items.slice(0, this.cap);
    this.store.write(this.items);
    this.bus.push({ kind: "notification", notification: item });
    return item;
  }

  list(): AppNotification[] {
    return this.items;
  }

  unread(): number {
    return this.items.filter((n) => !n.read).length;
  }

  markRead(id: string | null): void {
    for (const n of this.items) if (!id || n.id === id) n.read = true;
    this.store.write(this.items);
  }

  clear(): void {
    this.items = [];
    this.store.write(this.items);
  }
}
