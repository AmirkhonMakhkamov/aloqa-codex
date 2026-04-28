BEGIN;

DELETE FROM reactions WHERE reactor_type = 'guest';

DROP INDEX IF EXISTS idx_reactions_guest_session_id;
DROP INDEX IF EXISTS idx_reactions_msg_guest_emoji_unique;
DROP INDEX IF EXISTS idx_reactions_msg_user_emoji_unique;

ALTER TABLE reactions DROP CONSTRAINT IF EXISTS reactions_sender_check;
ALTER TABLE reactions
    DROP COLUMN IF EXISTS reactor_name_snapshot,
    DROP COLUMN IF EXISTS guest_session_id,
    DROP COLUMN IF EXISTS reactor_type;

ALTER TABLE reactions ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE reactions
    ADD CONSTRAINT reactions_msg_user_emoji_unique UNIQUE (message_id, user_id, emoji);

COMMIT;
