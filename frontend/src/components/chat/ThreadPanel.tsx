"use client";

import { useEffect } from "react";
import { X } from "lucide-react";
import type { Message, UUID } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useMessages } from "@/stores/messages";
import { Composer } from "./Composer";
import { MessageItem } from "./MessageItem";

interface Props {
  wsId: UUID;
  chId: UUID;
  parent: Message;
  authToken?: string;
  selfId?: UUID;
  className?: string;
  onClose: () => void;
}

export function ThreadPanel({ wsId, chId, parent, authToken, selfId, className, onClose }: Props) {
  const thread = useMessages((s) => s.threads[parent.id]);
  const loadThread = useMessages((s) => s.loadThread);

  useEffect(() => {
    void loadThread(wsId, chId, parent.id, { authToken });
  }, [wsId, chId, parent.id, authToken, loadThread]);

  const replies = thread?.replies ?? [];

  return (
    <aside className={cn("flex h-full w-[380px] shrink-0 flex-col border-l border-line bg-app", className)}>
      <header className="flex h-[52px] shrink-0 items-center justify-between border-b border-line px-4">
        <div className="min-w-0">
          <div className="text-[14px] font-semibold text-ink">Thread</div>
          <div className="text-[11px] text-ink-3">
            {replies.length} {replies.length === 1 ? "reply" : "replies"}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close thread"
          className="grid h-8 w-8 place-items-center rounded-md text-ink-2 transition hover:bg-app-2 hover:text-ink"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="border-b border-line pb-2">
          <MessageItem
            wsId={wsId}
            chId={chId}
            message={parent}
            authToken={authToken}
            selfId={selfId}
          />
        </div>
        {thread?.loading && !thread.loaded ? (
          <div className="flex items-center justify-center gap-2 p-6 text-[12px] text-ink-3">
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-line border-t-accent" />
            Loading replies…
          </div>
        ) : replies.length === 0 ? (
          <div className="p-6 text-center text-[12px] text-ink-3">
            No replies yet. Start the conversation.
          </div>
        ) : (
          replies.map((r, idx) => (
            <MessageItem
              key={r.id}
              wsId={wsId}
              chId={chId}
              message={r}
              authToken={authToken}
              selfId={selfId}
              compact={idx > 0 && messageSenderIdentity(replies[idx - 1]) === messageSenderIdentity(r)}
            />
          ))
        )}
      </div>

      <Composer
        wsId={wsId}
        chId={chId}
        parentId={parent.id}
        authToken={authToken}
        mentionsEnabled={!authToken}
        placeholder="Reply in thread…"
        allowAttachments={false}
      />
    </aside>
  );
}

function messageSenderIdentity(message: Message): string {
  return message.sender_type === "guest"
    ? (message.guest_session_id ?? message.id)
    : (message.user_id ?? message.id);
}
