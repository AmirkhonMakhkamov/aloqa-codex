-- Migration: 027_guest_reactions
-- Allows scoped meeting guests to react in hidden meeting chat threads.

BEGIN;

ALTER TABLE reactions
    ADD COLUMN IF NOT EXISTS reactor_type text NOT NULL DEFAULT 'user',
    ADD COLUMN IF NOT EXISTS guest_session_id uuid REFERENCES meeting_guest_sessions (id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS reactor_name_snapshot text;

ALTER TABLE reactions ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE reactions DROP CONSTRAINT IF EXISTS reactions_msg_user_emoji_unique;
ALTER TABLE reactions DROP CONSTRAINT IF EXISTS reactions_sender_check;
ALTER TABLE reactions ADD CONSTRAINT reactions_sender_check
    CHECK (
        (reactor_type = 'user' AND user_id IS NOT NULL AND guest_session_id IS NULL)
        OR
        (reactor_type = 'guest' AND user_id IS NULL AND guest_session_id IS NOT NULL)
    );

CREATE UNIQUE INDEX IF NOT EXISTS idx_reactions_msg_user_emoji_unique
    ON reactions (message_id, user_id, emoji)
    WHERE reactor_type = 'user' AND user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_reactions_msg_guest_emoji_unique
    ON reactions (message_id, guest_session_id, emoji)
    WHERE reactor_type = 'guest' AND guest_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reactions_guest_session_id ON reactions (guest_session_id)
    WHERE guest_session_id IS NOT NULL;

COMMIT;
