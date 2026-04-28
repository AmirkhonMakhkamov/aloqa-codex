"use client";

import { useEffect, useState } from "react";
import { MessageSquare } from "lucide-react";
import { Composer } from "@/components/chat/Composer";
import { MessageList } from "@/components/chat/MessageList";
import { ThreadPanel } from "@/components/chat/ThreadPanel";
import { TypingIndicator } from "@/components/chat/TypingIndicator";
import { cn } from "@/lib/utils";
import { RealtimeClient, rt } from "@/lib/ws/client";
import { rooms, type ServerEvent } from "@/lib/ws/events";
import type { Message, UUID } from "@/lib/types";
import { useMessages } from "@/stores/messages";

interface Props {
  wsId: UUID;
  chId: UUID;
  authToken?: string;
  resumeKey?: string;
  realtime?: RealtimeClient;
  className?: string;
}

export function MeetingChatPanel({ wsId, chId, authToken, resumeKey, realtime, className }: Props) {
  const [thread, setThread] = useState<Message | null>(null);

  useEffect(() => {
    const client =
      realtime ??
      (authToken
        ? new RealtimeClient({ accessToken: authToken, resumeKey: resumeKey ?? chId })
        : rt());
    client.start();
    const chatRoom = rooms.channel(chId);
    const typingRoom = rooms.typing(chId);
    client.subscribe(chatRoom);
    client.subscribe(typingRoom);

    let off: (() => void) | undefined;
    let typingTimer: number | undefined;
    if (authToken) {
      off = client.on((evt: ServerEvent) => useMessages.getState().applyEvent(evt));
      typingTimer = window.setInterval(
        () => useMessages.getState().clearStaleTyping(),
        1000,
      );
    }

    return () => {
      off?.();
      if (typingTimer) window.clearInterval(typingTimer);
      client.unsubscribe(chatRoom);
      client.unsubscribe(typingRoom);
      if (authToken && !realtime) client.stop();
    };
  }, [authToken, chId, realtime, resumeKey]);

  return (
    <aside className={cn("relative flex min-h-0 flex-col border-line bg-app text-ink", className)}>
      <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-line px-4">
        <MessageSquare className="h-4 w-4 text-ink-3" />
        <div className="text-sm font-semibold">Meeting chat</div>
      </header>
      <div className="min-h-0 flex-1">
        <MessageList
          wsId={wsId}
          chId={chId}
          authToken={authToken}
          selfId={resumeKey}
          onOpenThread={setThread}
        />
      </div>
      <TypingIndicator wsId={wsId} chId={chId} />
      <Composer
        wsId={wsId}
        chId={chId}
        authToken={authToken}
        mentionsEnabled={!authToken}
        allowAttachments={false}
        placeholder="Message meeting"
      />
      {thread ? (
        <div className="absolute inset-0 z-20 bg-app">
          <ThreadPanel
            wsId={wsId}
            chId={chId}
            parent={thread}
            authToken={authToken}
            selfId={resumeKey}
            className="w-full border-l-0"
            onClose={() => setThread(null)}
          />
        </div>
      ) : null}
    </aside>
  );
}
