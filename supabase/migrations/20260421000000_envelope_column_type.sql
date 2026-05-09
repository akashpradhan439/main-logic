-- M5: The envelope column was declared jsonb but stores a base64 string (protobuf
-- binary encoded as JSON string). Change to text; the USING clause strips the
-- surrounding JSON string quotes that jsonb::text would otherwise add.
ALTER TABLE messages
  ALTER COLUMN envelope TYPE text USING envelope #>> '{}';

COMMENT ON COLUMN messages.envelope IS 'Base64-encoded protobuf MessageEnvelope (header + ciphertext + optional bootstrap).';
