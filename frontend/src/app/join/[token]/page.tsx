"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { ArrowRight, Mic, MicOff, PhoneOff, UserRound, UsersRound, Video, VideoOff } from "lucide-react";
import { MeetingChatPanel } from "@/components/chat/MeetingChatPanel";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { callsApi, meetingInvitesApi } from "@/lib/api/endpoints";
import { cn } from "@/lib/utils";
import { createCallEngine, type CallEngine, type RemoteTrack } from "@/lib/webrtc/engine";
import { RealtimeClient } from "@/lib/ws/client";
import type { Call, CallParticipant, MeetingInviteJoinResult, MeetingInvitePreflight } from "@/lib/types";

const GUEST_SESSION_KEY = "aloqa.meeting_guest";

export default function MeetingInvitePage() {
  const { token } = useParams<{ token: string }>();
  const [info, setInfo] = useState<MeetingInvitePreflight | null>(null);
  const [joined, setJoined] = useState<MeetingInviteJoinResult | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [passcode, setPasscode] = useState("");
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    meetingInvitesApi
      .preflight(token)
      .then((next) => {
        if (!alive) return;
        setInfo(next);
        const stored = loadStoredGuestSession();
        if (
          stored &&
          stored.call_id === next.call_id &&
          stored.workspace_id === next.workspace_id &&
          Date.parse(stored.expires_at) > Date.now()
        ) {
          setJoined(stored);
        }
        setError(null);
      })
      .catch((err) => {
        if (!alive) return;
        setError(err instanceof Error ? err.message : "Meeting invite could not be loaded");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [token]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setJoining(true);
    setError(null);
    try {
      const result = await meetingInvitesApi.join(token, {
        display_name: displayName,
        passcode: passcode || undefined,
      });
      localStorage.setItem(GUEST_SESSION_KEY, JSON.stringify(result));
      setJoined(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not join meeting");
    } finally {
      setJoining(false);
    }
  }

  if (joined) {
    return (
      <GuestMeetingRoom
        title={info?.title || "Meeting"}
        session={joined}
        onLeave={() => {
          localStorage.removeItem(GUEST_SESSION_KEY);
          setJoined(null);
        }}
      />
    );
  }

  return (
    <main className="grid min-h-screen place-items-center bg-app px-4 py-10 text-ink">
      <section className="w-full max-w-sm space-y-5">
        <div>
          <div className="mb-3 grid h-11 w-11 place-items-center rounded-lg bg-accent-dim text-accent">
            <Video className="h-5 w-5" />
          </div>
          <h1 className="text-2xl font-semibold">{info?.title || "Join meeting"}</h1>
          <p className="mt-1 text-sm text-ink-3">
            {loading ? "Checking invite..." : info ? `${info.call_type} invite` : "Invite unavailable"}
          </p>
        </div>

        <form onSubmit={submit} className="space-y-3">
          <Field label="Display name">
            <div className="relative">
              <UserRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" />
              <Input
                className="pl-9"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Your name"
                disabled={loading || info?.status !== "active"}
              />
            </div>
          </Field>
          {info?.passcode_required ? (
            <Field label="Passcode">
              <Input
                value={passcode}
                onChange={(e) => setPasscode(e.target.value)}
                placeholder="Meeting passcode"
                type="password"
              />
            </Field>
          ) : null}
          <Button
            type="submit"
            className="w-full justify-center"
            loading={joining}
            disabled={loading || info?.status !== "active"}
          >
            Join as guest <ArrowRight className="h-4 w-4" />
          </Button>
        </form>

        {error ? (
          <div className="rounded-md border border-rose-900/60 bg-rose-950/40 p-3 text-sm text-rose-200">
            {error}
          </div>
        ) : null}
      </section>
    </main>
  );
}

function loadStoredGuestSession(): MeetingInviteJoinResult | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(GUEST_SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as MeetingInviteJoinResult;
  } catch {
    return null;
  }
}

function GuestMeetingRoom({
  title,
  session,
  onLeave,
}: {
  title: string;
  session: MeetingInviteJoinResult;
  onLeave: () => void;
}) {
  const [call, setCall] = useState<Call | null>(null);
  const [participants, setParticipants] = useState<CallParticipant[]>([]);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteTracks, setRemoteTracks] = useState<Record<string, RemoteTrack>>({});
  const [mediaState, setMediaState] = useState<"idle" | "joining" | "connected" | "failed">("idle");
  const [mediaError, setMediaError] = useState<string | null>(null);
  const engineRef = useRef<CallEngine | null>(null);
  const realtimeRef = useRef<RealtimeClient | null>(null);

  const viewer = session.role === "viewer";
  const auth = useMemo(() => ({ authToken: session.access_token }), [session.access_token]);

  useEffect(() => {
    let alive = true;
    Promise.all([
      callsApi.get(session.workspace_id, session.call_id, auth),
      callsApi.participants(session.workspace_id, session.call_id, auth),
    ])
      .then(([nextCall, nextParticipants]) => {
        if (!alive) return;
        setCall(nextCall);
        setParticipants(nextParticipants ?? []);
      })
      .catch((err) => {
        if (!alive) return;
        setMediaError(err instanceof Error ? err.message : "Could not load meeting");
      });
    return () => {
      alive = false;
    };
  }, [auth, session.call_id, session.workspace_id]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      callsApi
        .participants(session.workspace_id, session.call_id, auth)
        .then((next) => setParticipants(next ?? []))
        .catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [auth, session.call_id, session.workspace_id]);

  async function joinMedia() {
    setMediaState("joining");
    setMediaError(null);
    try {
      const realtime = new RealtimeClient({
        accessToken: session.access_token,
        resumeKey: session.guest_session_id,
      });
      realtimeRef.current = realtime;
      const engine = createCallEngine(session.workspace_id, session.call_id, session.guest_session_id, {
        authToken: session.access_token,
        realtime,
      });
      engineRef.current = engine;
      engine.on("local-stream", setLocalStream);
      engine.on("remote-track", (track) =>
        setRemoteTracks((current) => ({ ...current, [track.participantId]: track })),
      );
      engine.on("remote-track-removed", ({ participantId }) =>
        setRemoteTracks((current) => {
          const next = { ...current };
          delete next[participantId];
          return next;
        }),
      );
      engine.on("connection-state", (state) => {
        if (state === "connected") setMediaState("connected");
        if (state === "failed") setMediaState("failed");
      });
      engine.on("error", (err) => setMediaError(err.message));
      await engine.join({ audio: !viewer, video: !viewer });
      if (viewer) setMediaState("connected");
    } catch (err) {
      setMediaState("failed");
      setMediaError(err instanceof Error ? err.message : "Could not join media");
    }
  }

  async function leaveRoom() {
    await engineRef.current?.leave();
    realtimeRef.current?.stop();
    onLeave();
  }

  const remoteList = Object.values(remoteTracks);

  return (
    <main className="flex min-h-screen flex-col bg-app text-ink">
      <header className="flex min-h-16 items-center justify-between border-b border-line px-4">
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold">{call?.title || title}</h1>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-ink-3">
            <UsersRound className="h-3.5 w-3.5" />
            <span>{participants.length} participants</span>
            <span>{session.role}</span>
          </div>
        </div>
        <Button variant="danger" size="sm" onClick={leaveRoom}>
          <PhoneOff className="h-4 w-4" />
          Leave
        </Button>
      </header>

      <div className="grid min-h-0 flex-1 gap-4 p-4 lg:grid-cols-[1fr_360px]">
        <section className="grid min-h-[420px] grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <VideoTile label="You" stream={localStream} muted local idle={mediaState === "idle"} />
          {remoteList.map((track) => (
            <VideoTile
              key={`${track.participantId}:${track.kind}`}
              label={participantLabel(participants, track.participantId)}
              stream={track.stream}
            />
          ))}
        </section>

        <aside className="flex min-h-0 flex-col border-t border-line pt-4 lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0">
          <div className="mb-3 text-sm font-medium">Participants</div>
          <div className="max-h-[28vh] shrink-0 space-y-2 overflow-auto pr-1">
            {participants.map((p) => (
              <div key={p.id} className="flex items-center justify-between rounded-md bg-app-2 px-3 py-2 text-sm">
                <span className="min-w-0 truncate">{participantLabel(participants, participantIdentity(p))}</span>
                <span className="text-xs text-ink-3">{p.role}</span>
              </div>
            ))}
          </div>
          {session.meeting_channel_id ? (
            <MeetingChatPanel
              wsId={session.workspace_id}
              chId={session.meeting_channel_id}
              authToken={session.access_token}
              resumeKey={session.guest_session_id}
              className="mt-4 min-h-[360px] flex-1 rounded-lg border"
            />
          ) : null}
        </aside>
      </div>

      <footer className="flex min-h-16 items-center justify-center gap-2 border-t border-line px-4">
        {mediaState === "idle" || mediaState === "joining" || mediaState === "failed" ? (
          <Button onClick={joinMedia} loading={mediaState === "joining"}>
            {viewer ? <VideoOff className="h-4 w-4" /> : <Video className="h-4 w-4" />}
            Join media
          </Button>
        ) : null}
        {mediaState === "connected" ? (
          <>
            <Button variant="outline" size="sm" disabled={viewer}>
              {viewer ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
              Mic
            </Button>
            <Button variant="outline" size="sm" disabled={viewer}>
              {viewer ? <VideoOff className="h-4 w-4" /> : <Video className="h-4 w-4" />}
              Camera
            </Button>
          </>
        ) : null}
      </footer>

      {mediaError ? (
        <div className="border-t border-rose-900/60 bg-rose-950/40 px-4 py-3 text-sm text-rose-200">
          {mediaError}
        </div>
      ) : null}
    </main>
  );
}

function VideoTile({
  label,
  stream,
  muted,
  local,
  idle,
}: {
  label: string;
  stream: MediaStream | null;
  muted?: boolean;
  local?: boolean;
  idle?: boolean;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const hasVideo = Boolean(stream?.getVideoTracks().length);

  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);

  return (
    <div className="relative min-h-[220px] overflow-hidden rounded-lg border border-line bg-ink text-white">
      {hasVideo ? (
        <video
          ref={ref}
          autoPlay
          playsInline
          muted={muted}
          className={cn("h-full w-full object-cover", local && "scale-x-[-1]")}
        />
      ) : (
        <div className="grid h-full min-h-[220px] place-items-center">
          <div className="grid h-16 w-16 place-items-center rounded-full bg-white/10 text-lg font-semibold">
            {label.slice(0, 1).toUpperCase()}
          </div>
        </div>
      )}
      <div className="absolute bottom-2 left-2 rounded-md bg-black/55 px-2 py-1 text-xs">
        {idle ? "Ready" : label}
      </div>
    </div>
  );
}

function participantIdentity(p: CallParticipant): string {
  return p.guest_session_id || p.user_id || p.id;
}

function participantLabel(participants: CallParticipant[], id: string): string {
  const participant = participants.find((p) => participantIdentity(p) === id || p.id === id);
  if (!participant) return id.slice(0, 8);
  return participant.display_name_snapshot || participant.user_id?.slice(0, 8) || participant.id.slice(0, 8);
}
