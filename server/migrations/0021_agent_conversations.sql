CREATE TABLE agent_threads (
    id text PRIMARY KEY,
    account_id bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    title text NOT NULL DEFAULT '新对话' CHECK (char_length(title) BETWEEN 1 AND 80),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_threads_account_time ON agent_threads(account_id,updated_at DESC,id DESC);
CREATE TABLE agent_messages (
    id text PRIMARY KEY,
    thread_id text NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
    seq bigserial UNIQUE,
    request_id text,
    role text NOT NULL CHECK (role IN ('user','assistant')),
    content text NOT NULL DEFAULT '',
    state text NOT NULL DEFAULT 'complete' CHECK (state IN ('streaming','complete','aborted','error')),
    metadata jsonb NOT NULL DEFAULT '{}',
    error_code text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(thread_id,request_id)
);
CREATE INDEX agent_messages_thread_seq ON agent_messages(thread_id,seq);
CREATE UNIQUE INDEX agent_messages_one_generation ON agent_messages(thread_id) WHERE state='streaming';
