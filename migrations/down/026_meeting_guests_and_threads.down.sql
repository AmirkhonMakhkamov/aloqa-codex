BEGIN;

DELETE FROM messages WHERE sender_type = 'guest' OR user_id IS NULL;
DELETE FROM call_participants WHERE principal_type = 'guest' OR user_id IS NULL;

DROP INDEX IF EXISTS idx_messages_guest_session_id;
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_sender_check;
ALTER TABLE messages
    DROP COLUMN IF EXISTS sender_name_snapshot,
    DROP COLUMN IF EXISTS guest_session_id,
    DROP COLUMN IF EXISTS sender_type;
ALTER TABLE messages ALTER COLUMN user_id SET NOT NULL;

DROP INDEX IF EXISTS idx_call_participants_call_guest_unique;
DROP INDEX IF EXISTS idx_call_participants_call_user_unique;
ALTER TABLE call_participants DROP CONSTRAINT IF EXISTS call_participants_principal_check;
ALTER TABLE call_participants
    DROP COLUMN IF EXISTS display_name_snapshot,
    DROP COLUMN IF EXISTS guest_session_id,
    DROP COLUMN IF EXISTS principal_type;
ALTER TABLE call_participants ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE call_participants
    ADD CONSTRAINT call_participants_call_user_unique UNIQUE (call_id, user_id);

DROP TABLE IF EXISTS meeting_guest_sessions;
DROP TABLE IF EXISTS meeting_invite_links;

DROP INDEX IF EXISTS idx_calls_workspace_access_mode;
DROP INDEX IF EXISTS idx_calls_meeting_channel_id;
ALTER TABLE calls DROP CONSTRAINT IF EXISTS calls_access_mode_check;
ALTER TABLE calls
    DROP COLUMN IF EXISTS access_mode,
    DROP COLUMN IF EXISTS meeting_channel_id;

ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_type_check;
ALTER TABLE channels ADD CONSTRAINT channels_type_check
    CHECK (type IN ('public', 'private', 'dm', 'group_dm'));

COMMIT;
