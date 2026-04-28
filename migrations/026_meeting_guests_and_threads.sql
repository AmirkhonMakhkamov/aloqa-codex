-- Migration: 026_meeting_guests_and_threads
-- Adds hidden meeting chat channels, explicit call access modes, and
-- accountless meeting guest sessions scoped to a single call.

BEGIN;

ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_type_check;
ALTER TABLE channels ADD CONSTRAINT channels_type_check
    CHECK (type IN ('public', 'private', 'dm', 'group_dm', 'meeting'));

ALTER TABLE calls
    ADD COLUMN IF NOT EXISTS meeting_channel_id uuid REFERENCES channels (id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS access_mode text NOT NULL DEFAULT 'channel';

ALTER TABLE calls DROP CONSTRAINT IF EXISTS calls_access_mode_check;
ALTER TABLE calls ADD CONSTRAINT calls_access_mode_check
    CHECK (access_mode IN ('dm', 'channel', 'link', 'webinar'));

UPDATE calls
SET access_mode = CASE
    WHEN type IN ('one_to_one', 'group') THEN 'dm'
    WHEN type IN ('webinar', 'selector') THEN 'webinar'
    WHEN channel_id IS NULL THEN 'link'
    ELSE 'channel'
END;

CREATE INDEX IF NOT EXISTS idx_calls_meeting_channel_id ON calls (meeting_channel_id)
    WHERE meeting_channel_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_calls_workspace_access_mode ON calls (workspace_id, access_mode)
    WHERE status != 'ended';

CREATE TABLE IF NOT EXISTS meeting_invite_links (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    call_id         uuid        NOT NULL REFERENCES calls (id) ON DELETE CASCADE,
    token_hash      text        NOT NULL UNIQUE,
    passcode_hash   text        NOT NULL DEFAULT '',
    max_uses        integer     NOT NULL DEFAULT 1 CHECK (max_uses >= 0),
    use_count       integer     NOT NULL DEFAULT 0 CHECK (use_count >= 0),
    default_role    text        NOT NULL DEFAULT 'viewer'
                              CHECK (default_role IN ('host', 'co_host', 'presenter', 'participant', 'viewer')),
    expires_at      timestamptz NOT NULL,
    revoked_at      timestamptz,
    created_by      uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at      timestamptz NOT NULL DEFAULT now(),
    last_used_at    timestamptz
);

CREATE INDEX IF NOT EXISTS idx_meeting_invites_call_active
    ON meeting_invite_links (call_id, expires_at)
    WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_meeting_invites_workspace_created
    ON meeting_invite_links (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS meeting_guest_sessions (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id  uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    call_id       uuid        NOT NULL REFERENCES calls (id) ON DELETE CASCADE,
    invite_id     uuid        NOT NULL REFERENCES meeting_invite_links (id) ON DELETE CASCADE,
    display_name  text        NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 120),
    role          text        NOT NULL DEFAULT 'viewer'
                               CHECK (role IN ('host', 'co_host', 'presenter', 'participant', 'viewer')),
    token_hash    text        NOT NULL UNIQUE,
    expires_at    timestamptz NOT NULL,
    revoked_at    timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_seen_at  timestamptz
);

CREATE INDEX IF NOT EXISTS idx_meeting_guest_sessions_call_active
    ON meeting_guest_sessions (call_id, expires_at)
    WHERE revoked_at IS NULL;

ALTER TABLE call_participants
    ADD COLUMN IF NOT EXISTS principal_type text NOT NULL DEFAULT 'user',
    ADD COLUMN IF NOT EXISTS guest_session_id uuid REFERENCES meeting_guest_sessions (id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS display_name_snapshot text;

ALTER TABLE call_participants ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE call_participants DROP CONSTRAINT IF EXISTS call_participants_call_user_unique;
ALTER TABLE call_participants DROP CONSTRAINT IF EXISTS call_participants_principal_check;
ALTER TABLE call_participants ADD CONSTRAINT call_participants_principal_check
    CHECK (
        (principal_type = 'user' AND user_id IS NOT NULL AND guest_session_id IS NULL)
        OR
        (principal_type = 'guest' AND user_id IS NULL AND guest_session_id IS NOT NULL)
    );

CREATE UNIQUE INDEX IF NOT EXISTS idx_call_participants_call_user_unique
    ON call_participants (call_id, user_id)
    WHERE principal_type = 'user' AND user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_call_participants_call_guest_unique
    ON call_participants (call_id, guest_session_id)
    WHERE principal_type = 'guest' AND guest_session_id IS NOT NULL;

ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS sender_type text NOT NULL DEFAULT 'user',
    ADD COLUMN IF NOT EXISTS guest_session_id uuid REFERENCES meeting_guest_sessions (id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS sender_name_snapshot text;

ALTER TABLE messages ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_sender_check;
ALTER TABLE messages ADD CONSTRAINT messages_sender_check
    CHECK (
        (sender_type = 'user' AND user_id IS NOT NULL AND guest_session_id IS NULL)
        OR
        (sender_type = 'guest' AND user_id IS NULL AND guest_session_id IS NOT NULL)
    );

CREATE INDEX IF NOT EXISTS idx_messages_guest_session_id ON messages (guest_session_id)
    WHERE guest_session_id IS NOT NULL;

COMMIT;
