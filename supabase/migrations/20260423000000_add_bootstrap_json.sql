-- Persist bootstrap data alongside each message so reconnecting responders
-- can bootstrap a session from history (not just the real-time window).
ALTER TABLE messages ADD COLUMN bootstrap_json JSONB NULL;

-- Track the first sender in each conversation to provide a role hint
-- (initiator vs responder) without the client having to scan message history.
ALTER TABLE conversations ADD COLUMN initiator_user_id UUID NULL REFERENCES users(id);
