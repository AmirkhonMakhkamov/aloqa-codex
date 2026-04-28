"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  Check,
  Copy,
  Crown,
  Lock,
  LockOpen,
  LogOut,
  Mic,
  MicOff,
  MonitorUp,
  MonitorX,
  PhoneOff,
  Radio,
  Search,
  ShieldCheck,
  UserMinus,
  Users,
  Video,
  VideoOff,
  Wifi,
  WifiOff,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Avatar } from "@/components/ui/Avatar";
import { MeetingChatPanel } from "@/components/chat/MeetingChatPanel";
import { callsApi } from "@/lib/api/endpoints";
import {
  createCallEngine,
  isLikelySafariLockdown,
  isWebRTCSupported,
  type CallEngine,
  type EngineConnectionState,
} from "@/lib/webrtc/engine";
import { rt } from "@/lib/ws/client";
import { WS, type ServerEvent } from "@/lib/ws/events";
import type { Call, CallParticipant, UUID } from "@/lib/types";
import { useAuth } from "@/stores/auth";
import { useMembers, shortId } from "@/stores/members";

/*
 * Call room. Two planes need to stay in sync:
 *
 *   Control plane  — /calls/{id}/join|leave|end + /media (HTTP PUT).
 *                    The server is authoritative; WS events refresh this
 *                    view so mute states / joins / leaves from other tabs
 *                    appear immediately.
 *   Media plane    — WebRTC peer connection to the SFU via CallEngine.
 *                    The engine owns the <video> stream lifecycle; this
 *                    view just binds the streams it emits to <video>
 *                    elements keyed by participant id.
 *
 * We keep the visual language dark (bg-rail/bg-sidebar) so video tiles
 * pop — Aloqa's light main surface would blow out any webcam preview.
 */
export default function CallRoomPage() {
  const router = useRouter();
  const params = useParams<{ wsId: string; callId: string }>();
  const { wsId, callId } = params;
  const me = useAuth((s) => s.user);

  const [call, setCall] = useState<Call | null>(null);
  const [participants, setParticipants] = useState<CallParticipant[]>([]);
  const [joined, setJoined] = useState(false);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [hostSearch, setHostSearch] = useState("");

  // Media-plane state.
  const engineRef = useRef<CallEngine | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(
    new Map(),
  );
  const [engineState, setEngineState] = useState<EngineConnectionState>("idle");
  // Browser capability probe. Computed post-mount so SSR (which has no
  // `window`/RTCPeerConnection) doesn't render a permanent "unsupported"
  // banner. `null` = not yet checked; the PreJoinCard treats null as
  // "assume supported" so the loading flash is invisible.
  const [webrtcOk, setWebrtcOk] = useState<boolean | null>(null);
  const [lockdownLikely, setLockdownLikely] = useState(false);
  useEffect(() => {
    setWebrtcOk(isWebRTCSupported());
    setLockdownLikely(isLikelySafariLockdown());
  }, []);

  const myP =
    participants.find((p) => p.user_id === me?.id && !p.left_at && p.status !== "disconnected") ??
    null;
  const muted = Boolean(myP?.audio_muted);
  const videoOff = Boolean(myP?.video_muted);
  const screen = Boolean(myP?.screen_sharing);

  // ── Control plane ────────────────────────────────────────────────
  const load = useCallback(async () => {
    try {
      const [c, rawPs] = await Promise.all([
        callsApi.get(wsId, callId),
        callsApi.participants(wsId, callId),
      ]);
      const ps = rawPs ?? [];
      setCall(c);
      setParticipants(ps);
      setJoined(ps.some((p) => p.user_id === me?.id && !p.left_at && p.status !== "disconnected"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load");
    }
  }, [wsId, callId, me?.id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const client = rt();
    client.start();
    const handle = (evt: ServerEvent) => {
      if (
        evt.type !== WS.CallParticipantJoined &&
        evt.type !== WS.CallParticipantLeft &&
        evt.type !== WS.CallParticipantUpdated &&
        evt.type !== WS.CallUpdated &&
        evt.type !== WS.CallEnded
      )
        return;
      const payload = evt.payload as { call_id?: UUID };
      if (payload.call_id && payload.call_id !== callId) return;
      void load();
    };
    const off = client.on(handle);
    return () => off();
  }, [callId, load]);

  // ── Media plane ──────────────────────────────────────────────────
  // Construct the engine lazily on first join. Always tear it down on
  // navigation away — the browser will otherwise keep the camera LED on.
  useEffect(() => {
    return () => {
      void engineRef.current?.leave();
      engineRef.current = null;
    };
  }, []);

  async function join() {
    if (joining || engineRef.current) return;
    if (!me?.id) {
      // We need our own user id to subscribe to the per-user WS signal
      // room (aloqa.signal.{userId}); the SFU trickles ICE candidates
      // there. Without it the engine would silently never connect.
      setError("Authenticating… please retry in a moment.");
      return;
    }
    setJoining(true);
    setError(null);
    try {
      // Tell the backend first so the SFU already has a participant row
      // to attach the inbound SDP to when mediaOffer arrives. Skip if we
      // already appear in the HTTP participants list (e.g. host who just
      // created the call, or a returning user who hasn't been kicked).
      let participant = myP;
      if (!joined) {
        participant = await callsApi.join(wsId, callId);
      }
      const publishMedia = participant?.role !== "viewer";

      const engine = createCallEngine(wsId, callId, me.id);
      engineRef.current = engine;
      engine.on("local-stream", (s) => setLocalStream(s));
      engine.on("remote-track", (rt) => {
        setRemoteStreams((prev) => {
          const next = new Map(prev);
          const existing = next.get(rt.participantId);
          if (existing) {
            // Merge tracks into the existing stream so audio+video land in
            // a single <video> tile.
            for (const t of rt.stream.getTracks()) {
              if (!existing.getTracks().some((x) => x.id === t.id)) {
                existing.addTrack(t);
              }
            }
          } else {
            next.set(rt.participantId, rt.stream);
          }
          return next;
        });
      });
      engine.on("remote-track-removed", ({ participantId }) => {
        setRemoteStreams((prev) => {
          if (!prev.has(participantId)) return prev;
          const next = new Map(prev);
          next.delete(participantId);
          return next;
        });
      });
      engine.on("connection-state", (s) => setEngineState(s));
      engine.on("error", (err) => {
        // Only surface hard failures; a "media" stage error from a denied
        // mic doesn't mean the call is broken (we downgrade silently).
        if (err.stage === "signaling" || err.stage === "token") {
          setError(err.message);
        } else {
          console.warn("[CallEngine]", err.stage, err.message);
        }
      });

      await engine.join({ audio: publishMedia, video: publishMedia });

      // After we know which tracks actually came back from getUserMedia,
      // sync the control plane so other participants see the right mute
      // states. A denied mic → audio_muted = true, etc.
      const stream = engine.getLocalStream();
      const hasAudio =
        publishMedia && (stream?.getAudioTracks().some((t) => t.enabled) ?? false);
      const hasVideo =
        publishMedia && (stream?.getVideoTracks().some((t) => t.enabled) ?? false);
      await callsApi
        .updateMedia(wsId, callId, {
          audio_muted: !hasAudio,
          video_muted: !hasVideo,
          screen_sharing: false,
        })
        .catch(() => {
          /* control plane will re-sync on next WS event */
        });

      setJoined(true);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "join failed");
      engineRef.current = null;
    } finally {
      setJoining(false);
    }
  }

  async function leave() {
    try {
      await engineRef.current?.leave();
    } catch {
      /* ignore */
    }
    engineRef.current = null;
    setLocalStream(null);
    setRemoteStreams(new Map());
    try {
      await callsApi.leave(wsId, callId);
    } catch {
      /* ignore */
    }
    setJoined(false);
    router.push(`/w/${wsId}/calls`);
  }

  async function endMeeting() {
    if (!confirm("End the meeting for everyone?")) return;
    try {
      await engineRef.current?.leave();
    } catch {
      /* ignore */
    }
    engineRef.current = null;
    try {
      await callsApi.end(wsId, callId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not end");
      return;
    }
    router.push(`/w/${wsId}/calls`);
  }

  async function toggleMic() {
    const next = muted;
    // Mute in the engine first so we cut audio bytes before the server
    // event fans out to peers — gives us the snappier click-to-mute feel.
    await engineRef.current?.setMedia({ audio: next });
    try {
      await callsApi.updateMedia(wsId, callId, { audio_muted: !next });
      await load();
    } catch {
      /* ignore */
    }
  }

  async function toggleVideo() {
    const next = videoOff;
    await engineRef.current?.setMedia({ video: next });
    try {
      await callsApi.updateMedia(wsId, callId, { video_muted: !next });
      await load();
    } catch {
      /* ignore */
    }
  }

  async function toggleScreen() {
    const next = !screen;
    await engineRef.current?.setMedia({ screen: next });
    try {
      await callsApi.updateMedia(wsId, callId, { screen_sharing: next });
      await load();
    } catch {
      /* ignore */
    }
  }

  async function copyLink() {
    if (typeof window === "undefined") return;
    try {
      let url = window.location.href;
      if (isHost && live) {
        const invite = await callsApi.createInviteLink(wsId, callId, {
          max_uses: call?.access_mode === "webinar" ? 10000 : 100,
          ttl_hours: 72,
          default_role: call?.access_mode === "webinar" ? "viewer" : "participant",
        });
        url = `${window.location.origin}/join/${invite.token}`;
      }
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not create invite link");
    }
  }

  async function patchCallSettings(input: {
    locked?: boolean;
    waiting_room?: boolean;
    mute_on_join?: boolean;
    screen_sharing?: boolean;
    chat?: boolean;
    breakout_rooms?: boolean;
  }) {
    try {
      const updated = await callsApi.updateSettings(wsId, callId, input);
      setCall(updated);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not update meeting settings");
    }
  }

  async function setParticipantRole(participant: CallParticipant, role: CallParticipant["role"]) {
    try {
      await callsApi.updateParticipantRole(wsId, callId, {
        ...participantTarget(participant),
        role,
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not update participant role");
    }
  }

  async function muteParticipant(participant: CallParticipant, input: {
    audio_muted?: boolean;
    video_muted?: boolean;
    screen_sharing?: boolean;
  }) {
    try {
      await callsApi.muteParticipant(wsId, callId, {
        ...participantTarget(participant),
        ...input,
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not update participant media");
    }
  }

  async function admitParticipant(participant: CallParticipant) {
    try {
      await callsApi.admitParticipant(wsId, callId, participantTarget(participant));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not admit participant");
    }
  }

  async function rejectParticipant(participant: CallParticipant) {
    try {
      await callsApi.rejectParticipant(wsId, callId, participantTarget(participant));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not reject participant");
    }
  }

  async function removeParticipant(participant: CallParticipant) {
    if (!confirm("Remove this participant from the meeting?")) return;
    try {
      await callsApi.removeParticipant(wsId, callId, participantTarget(participant));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not remove participant");
    }
  }

  // ── Derived ──────────────────────────────────────────────────────
  const visibleParticipants = useMemo(
    () => participants.filter((p) => !p.left_at && p.status !== "disconnected"),
    [participants],
  );
  const activeParticipants = useMemo(
    () => visibleParticipants.filter((p) => p.status !== "waiting"),
    [visibleParticipants],
  );
  const waitingParticipants = useMemo(
    () => visibleParticipants.filter((p) => p.status === "waiting"),
    [visibleParticipants],
  );
  const isHost = myP?.role === "host" || myP?.role === "co_host";
  // Backend transitions ringing → active when the first participant actually
  // joins the SFU. From the host's perspective the meeting is "live" the
  // moment it's created — don't flash "ended" on a brand-new ringing call.
  const live = call ? call.status !== "ended" : false;
  const statusLabel =
    call?.status === "ringing" ? "Waiting" : live ? "Live" : "Ended";
  // The media engine is "connected" once it has at least begun signaling.
  // Idle/closed/failed all mean we owe the user a pre-join prompt before
  // we touch the camera again.
  const mediaConnected =
    engineState !== "idle" &&
    engineState !== "closed" &&
    engineState !== "failed";

  if (error && !call) {
    return (
      <div className="flex h-full items-center justify-center bg-rail text-sm text-status-red">
        {error}
      </div>
    );
  }
  if (!call) {
    return (
      <div className="flex h-full items-center justify-center bg-rail text-sm text-white/60">
        Loading meeting…
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-rail">
      {/* Header */}
      <header className="flex h-[52px] items-center gap-4 border-b border-white/5 bg-sidebar px-6">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-white">
            {call.title}
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[11px] text-white/50">
            <span className="capitalize">{call.type.replace("_", " ")}</span>
            <span className="text-white/20">·</span>
            <span
              className={cn(
                "inline-flex items-center gap-1",
                live ? "text-status-green" : "text-white/50",
              )}
            >
              {live ? (
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-status-green opacity-70" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-status-green" />
                </span>
              ) : null}
              {statusLabel}
            </span>
            {joined ? (
              <>
                <span className="text-white/20">·</span>
                <EngineStateBadge state={engineState} />
              </>
            ) : null}
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <span className="hidden items-center gap-1.5 rounded-md bg-white/5 px-2.5 py-1 text-[11px] text-white/60 sm:inline-flex">
            <Users className="h-3 w-3" />
            {activeParticipants.length} participant
            {activeParticipants.length === 1 ? "" : "s"}
          </span>
          <button
            onClick={copyLink}
            className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-white/80 transition-colors hover:bg-white/10"
            title={isHost ? "Copy guest invite link" : "Copy meeting link"}
          >
            {copied ? (
              <>
                <Check className="h-3 w-3" /> Copied
              </>
            ) : (
              <>
                <Copy className="h-3 w-3" /> {isHost ? "Invite" : "Copy link"}
              </>
            )}
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Stage */}
          <div className="flex-1 overflow-auto px-6 py-6">
            {error && call ? (
              <div className="mx-auto mb-4 max-w-md rounded-lg border border-status-red/40 bg-status-red/10 px-4 py-2 text-center text-xs text-status-red">
                {error}
              </div>
            ) : null}

            {!mediaConnected ? (
              <PreJoinCard
                live={live}
                joining={joining}
                alreadyInRoom={joined}
                webrtcOk={webrtcOk}
                lockdownLikely={lockdownLikely}
                onJoin={join}
                onCancel={() => router.push(`/w/${wsId}/calls`)}
              />
            ) : activeParticipants.length === 0 ? (
              <EmptyStage live={live} />
            ) : (
              <div
                className={cn(
                  "mx-auto grid w-full max-w-6xl gap-4",
                  activeParticipants.length === 1
                    ? "grid-cols-1"
                    : activeParticipants.length === 2
                      ? "grid-cols-1 md:grid-cols-2"
                      : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
                )}
              >
                {activeParticipants.map((p) => {
                  const isSelf = p.user_id === me?.id;
                  const stream = isSelf ? localStream : remoteStreams.get(p.id);
                  return (
                    <ParticipantTile
                      key={p.id}
                      wsId={wsId}
                      participant={p}
                      stream={stream ?? null}
                      isSelf={isSelf}
                    />
                  );
                })}
              </div>
            )}
          </div>

          {/* Control bar */}
          {mediaConnected ? (
            <footer className="flex h-[80px] items-center justify-center gap-3 border-t border-white/5 bg-sidebar px-6">
              <CircleButton
                active={!muted}
                dangerWhenOff
                onIcon={<Mic className="h-5 w-5" />}
                offIcon={<MicOff className="h-5 w-5" />}
                label={muted ? "Unmute" : "Mute"}
                onClick={toggleMic}
              />
              <CircleButton
                active={!videoOff}
                dangerWhenOff
                onIcon={<Video className="h-5 w-5" />}
                offIcon={<VideoOff className="h-5 w-5" />}
                label={videoOff ? "Start video" : "Stop video"}
                onClick={toggleVideo}
              />
              <CircleButton
                active={screen}
                tone="accent"
                onIcon={<MonitorUp className="h-5 w-5" />}
                offIcon={<MonitorX className="h-5 w-5" />}
                label={screen ? "Stop sharing" : "Share screen"}
                onClick={toggleScreen}
              />

              <div className="mx-2 h-8 w-px bg-white/10" />

              <button
                onClick={leave}
                title="Leave"
                className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-status-red text-white transition-colors hover:bg-status-red/90"
              >
                <LogOut className="h-5 w-5" />
              </button>
              {isHost && live ? (
                <button
                  onClick={endMeeting}
                  title="End for all"
                  className="inline-flex h-10 items-center gap-2 rounded-full border border-white/15 bg-transparent px-4 text-sm text-white/80 transition-colors hover:bg-white/10"
                >
                  <PhoneOff className="h-4 w-4" />
                  End for all
                </button>
              ) : null}
            </footer>
          ) : null}
	        </div>
	        {isHost && live ? (
	          <HostControlsPanel
	            wsId={wsId}
	            call={call}
	            me={myP}
	            participants={visibleParticipants}
	            waitingParticipants={waitingParticipants}
	            search={hostSearch}
	            onSearch={setHostSearch}
	            onPatchSettings={patchCallSettings}
	            onSetRole={setParticipantRole}
	            onMute={muteParticipant}
	            onAdmit={admitParticipant}
	            onReject={rejectParticipant}
	            onRemove={removeParticipant}
	          />
	        ) : null}
	        {call.meeting_channel_id ? (
	          <MeetingChatPanel
	            wsId={wsId}
            chId={call.meeting_channel_id}
            className="hidden w-[360px] shrink-0 border-l lg:flex"
          />
        ) : null}
      </div>
    </div>
  );
}

type ParticipantRole = CallParticipant["role"];
type ParticipantTargetInput = { user_id: UUID } | { guest_session_id: UUID };

function HostControlsPanel({
  wsId,
  call,
  me,
  participants,
  waitingParticipants,
  search,
  onSearch,
  onPatchSettings,
  onSetRole,
  onMute,
  onAdmit,
  onReject,
  onRemove,
}: {
  wsId: string;
  call: Call;
  me: CallParticipant | null;
  participants: CallParticipant[];
  waitingParticipants: CallParticipant[];
  search: string;
  onSearch: (value: string) => void;
  onPatchSettings: (patch: {
    locked?: boolean;
    waiting_room?: boolean;
    mute_on_join?: boolean;
    screen_sharing?: boolean;
    chat?: boolean;
    breakout_rooms?: boolean;
  }) => void;
  onSetRole: (participant: CallParticipant, role: ParticipantRole) => void;
  onMute: (
    participant: CallParticipant,
    patch: { audio_muted?: boolean; video_muted?: boolean; screen_sharing?: boolean },
  ) => void;
  onAdmit: (participant: CallParticipant) => void;
  onReject: (participant: CallParticipant) => void;
  onRemove: (participant: CallParticipant) => void;
}) {
  const memberMap = useMembers((s) => s.byWorkspace[wsId] ?? {});
  const settings = call.settings ?? {};
  const roleOptions = roleOptionsFor(call, me);
  const query = search.trim().toLowerCase();
  const admittedParticipants = useMemo(
    () =>
      participants
        .filter((p) => p.status !== "waiting")
        .filter((p) => {
          if (!query) return true;
          return participantName(p, memberMap).toLowerCase().includes(query);
        }),
    [memberMap, participants, query],
  );

  return (
    <aside className="hidden w-[320px] shrink-0 flex-col border-l border-white/5 bg-sidebar/80 lg:flex">
      <div className="border-b border-white/5 px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-white">
          <ShieldCheck className="h-4 w-4 text-accent" />
          Host controls
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <ToggleButton
            checked={Boolean(settings.locked)}
            onChange={(checked) => onPatchSettings({ locked: checked })}
            onIcon={<Lock className="h-3.5 w-3.5" />}
            offIcon={<LockOpen className="h-3.5 w-3.5" />}
            label="Locked"
          />
          <ToggleButton
            checked={Boolean(settings.waiting_room)}
            onChange={(checked) => onPatchSettings({ waiting_room: checked })}
            onIcon={<Users className="h-3.5 w-3.5" />}
            offIcon={<Users className="h-3.5 w-3.5" />}
            label="Waiting room"
          />
        </div>
      </div>

      {waitingParticipants.length > 0 ? (
        <div className="border-b border-white/5 px-4 py-3">
          <div className="mb-2 flex items-center justify-between text-xs font-medium uppercase text-white/50">
            <span>Waiting</span>
            <span>{waitingParticipants.length}</span>
          </div>
          <div className="space-y-2">
            {waitingParticipants.map((participant) => (
              <WaitingParticipantRow
                key={participant.id}
                participant={participant}
                name={participantName(participant, memberMap)}
                onAdmit={() => onAdmit(participant)}
                onReject={() => onReject(participant)}
              />
            ))}
          </div>
        </div>
      ) : null}

      <div className="border-b border-white/5 px-4 py-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/35" />
          <input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search participants"
            className="h-9 w-full rounded-md border border-white/10 bg-white/5 pl-8 pr-3 text-sm text-white outline-none placeholder:text-white/35 focus:border-accent"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-auto px-4 py-3">
        {admittedParticipants.length === 0 ? (
          <div className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-4 text-center text-xs text-white/45">
            No participants found.
          </div>
        ) : (
          admittedParticipants.map((participant) => (
            <HostParticipantRow
              key={participant.id}
              participant={participant}
              me={me}
              name={participantName(participant, memberMap)}
              roleOptions={roleOptions}
              onSetRole={(role) => onSetRole(participant, role)}
              onMute={(patch) => onMute(participant, patch)}
              onRemove={() => onRemove(participant)}
            />
          ))
        )}
      </div>
    </aside>
  );
}

function ToggleButton({
  checked,
  onChange,
  onIcon,
  offIcon,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  onIcon: React.ReactNode;
  offIcon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        "inline-flex h-9 items-center justify-center gap-1.5 rounded-md border px-2 text-xs transition-colors",
        checked
          ? "border-accent/40 bg-accent/20 text-white"
          : "border-white/10 bg-white/5 text-white/60 hover:bg-white/10",
      )}
    >
      {checked ? onIcon : offIcon}
      <span className="truncate">{label}</span>
    </button>
  );
}

function WaitingParticipantRow({
  participant,
  name,
  onAdmit,
  onReject,
}: {
  participant: CallParticipant;
  name: string;
  onAdmit: () => void;
  onReject: () => void;
}) {
  return (
    <div className="rounded-lg border border-status-yellow/20 bg-status-yellow/10 p-2">
      <div className="flex items-center gap-2">
        <Avatar name={name} src={null} size={28} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-white">{name}</div>
          <div className="text-[11px] text-white/45">{roleName(participant.role)}</div>
        </div>
        <IconButton label="Admit" onClick={onAdmit}>
          <Check className="h-3.5 w-3.5" />
        </IconButton>
        <IconButton label="Reject" danger onClick={onReject}>
          <UserMinus className="h-3.5 w-3.5" />
        </IconButton>
      </div>
    </div>
  );
}

function HostParticipantRow({
  participant,
  me,
  name,
  roleOptions,
  onSetRole,
  onMute,
  onRemove,
}: {
  participant: CallParticipant;
  me: CallParticipant | null;
  name: string;
  roleOptions: ParticipantRole[];
  onSetRole: (role: ParticipantRole) => void;
  onMute: (patch: { audio_muted?: boolean; video_muted?: boolean; screen_sharing?: boolean }) => void;
  onRemove: () => void;
}) {
  const isSelf = participant.id === me?.id;
  const canChangeRole = participant.role !== "host" && !isSelf;
  const canRemove = participant.role !== "host" && !isSelf;
  const selectRoles = uniqueRoles([participant.role, ...roleOptions]);

  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] p-2">
      <div className="flex items-center gap-2">
        <Avatar name={name} src={null} size={30} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-xs font-medium text-white">{name}</span>
            {participant.role === "host" ? <Crown className="h-3 w-3 shrink-0 text-status-yellow" /> : null}
          </div>
          <div className="text-[11px] text-white/45">
            {participant.principal_type === "guest" ? "Guest" : "Member"}
            {participant.status ? ` - ${participant.status}` : ""}
          </div>
        </div>
      </div>

      <div className="mt-2 flex items-center gap-1.5">
        <select
          value={participant.role}
          disabled={!canChangeRole}
          onChange={(e) => onSetRole(e.target.value as ParticipantRole)}
          className="h-8 min-w-0 flex-1 rounded-md border border-white/10 bg-sidebar px-2 text-xs text-white outline-none disabled:opacity-45"
        >
          {selectRoles.map((role) => (
            <option key={role} value={role}>
              {roleName(role)}
            </option>
          ))}
        </select>
        <IconButton
          label="Mute audio"
          disabled={participant.audio_muted}
          onClick={() => onMute({ audio_muted: true })}
        >
          <MicOff className="h-3.5 w-3.5" />
        </IconButton>
        <IconButton
          label="Stop video"
          disabled={participant.video_muted}
          onClick={() => onMute({ video_muted: true })}
        >
          <VideoOff className="h-3.5 w-3.5" />
        </IconButton>
        <IconButton
          label="Stop sharing"
          disabled={!participant.screen_sharing}
          onClick={() => onMute({ screen_sharing: false })}
        >
          <MonitorX className="h-3.5 w-3.5" />
        </IconButton>
        <IconButton label="Remove" danger disabled={!canRemove} onClick={onRemove}>
          <UserMinus className="h-3.5 w-3.5" />
        </IconButton>
      </div>
    </div>
  );
}

function IconButton({
  label,
  children,
  onClick,
  danger = false,
  disabled = false,
}: {
  label: string;
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "grid h-8 w-8 shrink-0 place-items-center rounded-md border transition-colors disabled:cursor-not-allowed disabled:opacity-35",
        danger
          ? "border-status-red/30 bg-status-red/10 text-status-red hover:bg-status-red/20"
          : "border-white/10 bg-white/5 text-white/70 hover:bg-white/10",
      )}
    >
      {children}
    </button>
  );
}

function roleOptionsFor(call: Call, actor: CallParticipant | null): ParticipantRole[] {
  const webinar = call.type === "webinar" || call.type === "selector" || call.access_mode === "webinar";
  const base: ParticipantRole[] = webinar
    ? ["viewer", "participant", "presenter", "co_host"]
    : ["participant", "presenter", "co_host"];
  if (actor?.role !== "host") return base.filter((role) => role !== "co_host");
  return base;
}

function uniqueRoles(roles: ParticipantRole[]): ParticipantRole[] {
  return roles.filter((role, index) => roles.indexOf(role) === index);
}

function roleName(role: ParticipantRole): string {
  switch (role) {
    case "co_host":
      return "Co-host";
    case "presenter":
      return "Presenter";
    case "viewer":
      return "Viewer";
    case "host":
      return "Host";
    default:
      return "Participant";
  }
}

function participantTarget(participant: CallParticipant): ParticipantTargetInput {
  if (participant.guest_session_id) {
    return { guest_session_id: participant.guest_session_id };
  }
  if (participant.user_id) {
    return { user_id: participant.user_id };
  }
  throw new Error("participant target is missing");
}

function participantName(
  participant: CallParticipant,
  members: Record<string, { display_name?: string | null } | undefined>,
): string {
  return (
    participant.display_name_snapshot ??
    (participant.user_id ? members[participant.user_id]?.display_name : undefined) ??
    shortId(participant.guest_session_id ?? participant.user_id ?? participant.id)
  );
}

// ── Pre-join card ────────────────────────────────────────────────
function PreJoinCard({
  live,
  joining,
  alreadyInRoom,
  webrtcOk,
  lockdownLikely,
  onJoin,
  onCancel,
}: {
  live: boolean;
  joining: boolean;
  alreadyInRoom: boolean;
  // null = capability check not yet completed (SSR / first paint). We
  // treat null as "assume supported" so the join CTA isn't suppressed by
  // a flash of the unsupported state.
  webrtcOk: boolean | null;
  lockdownLikely: boolean;
  onJoin: () => void;
  onCancel: () => void;
}) {
  // Capability gate. When the browser can't construct an
  // RTCPeerConnection (Safari Lockdown Mode being the realistic case),
  // refuse to even render the "Join meeting" button — clicking would
  // immediately fail with a cryptic ReferenceError. Instead, surface an
  // actionable message naming the exact toggle to flip.
  const blocked = webrtcOk === false;
  if (blocked) {
    return (
      <div className="mx-auto flex h-full max-w-md flex-col items-center justify-center gap-4 text-center">
        <div className="grid h-16 w-16 place-items-center rounded-2xl bg-status-red/15 text-status-red">
          <WifiOff className="h-7 w-7" />
        </div>
        <div>
          <div className="text-lg font-semibold text-white">
            WebRTC unavailable in this browser
          </div>
          <p className="mt-1 text-sm text-white/60">
            {lockdownLikely
              ? "Safari Lockdown Mode is enabled, which blocks WebRTC. Disable it for this site under Settings → Privacy & Security → Lockdown Mode → Configure for Safari, then reload."
              : "This browser doesn't expose RTCPeerConnection. Try the latest Chrome, Edge, Firefox, or Safari (with Lockdown Mode off)."}
          </p>
        </div>
        <button
          onClick={onCancel}
          className="inline-flex h-11 items-center justify-center rounded-lg border border-white/15 bg-transparent px-5 text-sm text-white/80 transition-colors hover:bg-white/10"
        >
          Back to calls
        </button>
      </div>
    );
  }
  const headline = !live
    ? "This meeting has ended."
    : alreadyInRoom
      ? "Reconnect to media?"
      : "Ready to join?";
  const subline = !live
    ? "The host ended this meeting. You can review recent calls or start a new one."
    : alreadyInRoom
      ? "You're listed in this room but media isn't connected. Reconnect to see and hear participants."
      : "We'll ask for your microphone and camera. You can mute before others see you.";
  return (
    <div className="mx-auto flex h-full max-w-md flex-col items-center justify-center gap-4 text-center">
      <div className="grid h-16 w-16 place-items-center rounded-2xl bg-white/5">
        <Radio className="h-7 w-7 text-white/70" />
      </div>
      <div>
        <div className="text-lg font-semibold text-white">{headline}</div>
        <p className="mt-1 text-sm text-white/60">{subline}</p>
      </div>
      <div className="mt-2 flex items-center gap-2">
        {live ? (
          <button
            onClick={onJoin}
            disabled={joining}
            className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-accent px-5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:bg-accent/40"
          >
            {joining ? (
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/60 border-t-transparent" />
            ) : (
              <Video className="h-4 w-4" />
            )}
            {joining ? "Connecting…" : "Join meeting"}
          </button>
        ) : null}
        <button
          onClick={onCancel}
          className="inline-flex h-11 items-center justify-center rounded-lg border border-white/15 bg-transparent px-5 text-sm text-white/80 transition-colors hover:bg-white/10"
        >
          {live ? "Cancel" : "Back to calls"}
        </button>
      </div>
    </div>
  );
}

function EmptyStage({ live }: { live: boolean }) {
  return (
    <div className="mx-auto flex h-full max-w-md flex-col items-center justify-center gap-2 text-center">
      <div className="grid h-14 w-14 place-items-center rounded-xl bg-white/5">
        <Users className="h-6 w-6 text-white/50" />
      </div>
      <div className="text-sm font-medium text-white">
        {live ? "You're first in." : "This meeting has ended."}
      </div>
      <p className="text-xs text-white/50">
        {live
          ? "Share the link and participants will appear here as they join."
          : "Participants have left the room."}
      </p>
    </div>
  );
}

// ── Participant tile ─────────────────────────────────────────────
function ParticipantTile({
  wsId,
  participant,
  stream,
  isSelf,
}: {
  wsId: string;
  participant: CallParticipant;
  stream: MediaStream | null;
  isSelf: boolean;
}) {
  const user = useMembers((s) =>
    participant.user_id ? s.get(wsId, participant.user_id) : undefined,
  );
  const name =
    participant.display_name_snapshot ??
    user?.display_name ??
    shortId(participant.guest_session_id ?? participant.user_id ?? participant.id);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Bind stream to the <video> element imperatively — srcObject can't be
  // set declaratively in React. We also call play() explicitly because
  // Chrome can leave the element paused after the previous stream's only
  // video track was stopped (e.g., camera off → on cycle): autoPlay only
  // fires on initial bind, not when srcObject is re-set on the same node.
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (el.srcObject !== stream) {
      el.srcObject = stream;
    }
    if (stream) {
      el.play().catch(() => {
        /* fine: play() rejects if the element was paused mid-bind, the
         * next user gesture or the next stream change will resume it */
      });
    }
  }, [stream]);

  // hasVideoTrack drives the avatar-vs-video swap. We accept tracks that
  // haven't reached "live" yet ("new" is the brief readyState immediately
  // after replaceTrack) — gating on "live" only would render the avatar
  // for the first paint after camera-on and then never re-render because
  // no React state changes once the track flips to "live".
  const hasVideoTrack =
    (stream?.getVideoTracks().some(
      (t) => t.enabled && t.readyState !== "ended",
    ) ?? false) && !participant.video_muted;

  const roleLabel =
    participant.role === "host"
      ? "Host"
      : participant.role === "co_host"
        ? "Co-host"
        : participant.role === "presenter"
          ? "Presenter"
          : null;

  return (
    <div className="relative aspect-video overflow-hidden rounded-xl border border-white/5 bg-sidebar">
      {hasVideoTrack ? (
        // key on stream.id forces a fresh <video> node whenever the
        // engine swaps the local MediaStream (camera off→on, screen
        // share start/stop). React reuses the node by default and Chrome
        // sometimes refuses to repaint after the only video track was
        // stopped + re-added on the same element.
        <video
          key={stream?.id ?? "no-stream"}
          ref={videoRef}
          autoPlay
          playsInline
          muted={isSelf}
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : (
        <div className="absolute inset-0 grid place-items-center">
          <Avatar name={name} src={user?.avatar_url ?? null} size={80} />
        </div>
      )}

      {/* Top-left role badge */}
      {roleLabel ? (
        <div className="absolute left-2 top-2 rounded-md bg-black/50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-white/80 backdrop-blur">
          {roleLabel}
        </div>
      ) : null}

      {/* Bottom: name + media badges */}
      <div className="absolute inset-x-2 bottom-2 flex items-center gap-2">
        <span className="inline-flex min-w-0 items-center gap-1.5 rounded-md bg-black/55 px-2 py-0.5 text-xs text-white backdrop-blur">
          {participant.audio_muted ? (
            <MicOff className="h-3 w-3 text-status-red" />
          ) : null}
          <span className="truncate">{name}</span>
          {isSelf ? <span className="text-white/50">(you)</span> : null}
        </span>
        <div className="ml-auto flex gap-1">
          {participant.video_muted ? (
            <span className="grid h-6 w-6 place-items-center rounded-full bg-black/55 text-white/80 backdrop-blur">
              <VideoOff className="h-3 w-3" />
            </span>
          ) : null}
          {participant.screen_sharing ? (
            <span className="grid h-6 w-6 place-items-center rounded-full bg-accent text-white">
              <MonitorUp className="h-3 w-3" />
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ── Control bar button ───────────────────────────────────────────
function CircleButton({
  active,
  onIcon,
  offIcon,
  label,
  onClick,
  tone = "neutral",
  dangerWhenOff = false,
}: {
  active: boolean;
  onIcon: React.ReactNode;
  offIcon: React.ReactNode;
  label: string;
  onClick: () => void;
  tone?: "neutral" | "accent";
  // When the feature being off is *itself* a problem (mic muted, video
  // off), flag it red so the user notices. For opt-in features like
  // screen-share, "off" is just the default — keep the pill neutral.
  dangerWhenOff?: boolean;
}) {
  const off = !active;
  const dangerStyle = "bg-status-red text-white hover:bg-status-red/90";
  const accentStyle = "bg-accent text-white hover:bg-accent-hover";
  const neutralStyle = "bg-white/10 text-white hover:bg-white/15";
  const style = off
    ? dangerWhenOff
      ? dangerStyle
      : neutralStyle
    : tone === "accent"
      ? accentStyle
      : neutralStyle;
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        "inline-flex h-12 w-12 items-center justify-center rounded-full transition-colors",
        style,
      )}
    >
      {active ? onIcon : offIcon}
    </button>
  );
}

// ── Engine connection state pip ──────────────────────────────────
function EngineStateBadge({ state }: { state: EngineConnectionState }) {
  const map: Record<
    EngineConnectionState,
    { label: string; tint: string; icon: React.ReactNode }
  > = {
    idle: { label: "Idle", tint: "text-white/50", icon: <WifiOff className="h-3 w-3" /> },
    "acquiring-media": {
      label: "Acquiring devices",
      tint: "text-white/60",
      icon: <WifiOff className="h-3 w-3" />,
    },
    signaling: {
      label: "Connecting",
      tint: "text-status-yellow",
      icon: <WifiOff className="h-3 w-3" />,
    },
    connected: {
      label: "Connected",
      tint: "text-status-green",
      icon: <Wifi className="h-3 w-3" />,
    },
    reconnecting: {
      label: "Reconnecting",
      tint: "text-status-yellow",
      icon: <WifiOff className="h-3 w-3" />,
    },
    closed: { label: "Closed", tint: "text-white/50", icon: <WifiOff className="h-3 w-3" /> },
    failed: { label: "Failed", tint: "text-status-red", icon: <WifiOff className="h-3 w-3" /> },
  };
  const info = map[state];
  return (
    <span className={cn("inline-flex items-center gap-1", info.tint)}>
      {info.icon}
      {info.label}
    </span>
  );
}
