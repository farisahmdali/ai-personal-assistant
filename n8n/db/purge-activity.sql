-- Deletes all raw computer/coding activity and temporary work sessions.
-- Long-term memories are kept; delete those from the memories table if needed.
-- Permanent. Run manually.

TRUNCATE activity_events, work_sessions;
