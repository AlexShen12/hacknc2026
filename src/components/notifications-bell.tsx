"use client";

import { Bell } from "lucide-react";
import Link from "next/link";
import { Popover } from "radix-ui";
import { useCallback, useEffect, useState } from "react";
import { api, REFRESH_EVENT } from "@/lib/api-client";

interface Feed {
  unread: number;
  items: {
    id: string;
    groupId: string | null;
    message: string;
    createdAt: string;
    read: boolean;
  }[];
}

const time = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  minute: "2-digit",
});

/** Activity feed for the selected shopper; polls while the page is open. */
export function NotificationsBell({ shopperId }: { shopperId: string | null }) {
  const [feed, setFeed] = useState<Feed>({ unread: 0, items: [] });
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      setFeed(await api<Feed>("/api/notifications"));
    } catch {
      // Keep the last feed on transient errors.
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload when the persona changes
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 4000);
    const listener = () => void load();
    window.addEventListener(REFRESH_EVENT, listener);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener(REFRESH_EVENT, listener);
    };
  }, [load, shopperId]);

  async function toggle(next: boolean) {
    setOpen(next);
    if (next && feed.unread > 0) {
      await api("/api/notifications/read", { body: {} }).catch(() => undefined);
      setFeed((current) => ({
        unread: 0,
        items: current.items.map((item) => ({ ...item, read: true })),
      }));
    }
  }

  return (
    <Popover.Root open={open} onOpenChange={(next) => void toggle(next)}>
      <Popover.Trigger
        className="relative rounded-lg p-2 text-ink hover:bg-sunken"
        aria-label={feed.unread > 0 ? `Notifications, ${feed.unread} unread` : "Notifications"}
      >
        <Bell size={20} aria-hidden />
        {feed.unread > 0 ? (
          <span className="absolute -top-0.5 -right-0.5 grid min-w-5 place-items-center rounded-full bg-savings px-1 text-xs font-bold text-white">
            {feed.unread}
          </span>
        ) : null}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          className="z-50 max-h-[70vh] w-[min(24rem,calc(100vw-2rem))] overflow-y-auto rounded-2xl border border-line bg-surface p-2 shadow-xl"
        >
          <p className="px-2 py-1 text-sm font-bold">Activity</p>
          {feed.items.length === 0 ? (
            <p className="px-2 py-3 text-sm text-muted">
              Nothing yet. Updates about your groups appear here.
            </p>
          ) : (
            <ul className="flex flex-col">
              {feed.items.map((item) => (
                <li key={item.id}>
                  <Link
                    href={item.groupId ? `/groups/${item.groupId}` : "/shop"}
                    onClick={() => setOpen(false)}
                    className="flex flex-col gap-0.5 rounded-xl px-2 py-2 text-sm hover:bg-sunken"
                  >
                    <span className={item.read ? "text-muted" : "font-semibold"}>
                      {item.message}
                    </span>
                    <span className="text-xs text-muted">
                      {time.format(new Date(item.createdAt))}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
