-- App-owned billing data. auth.users is managed by Supabase Auth.
-- Only the backend may write provider-verified subscription state and events.
CREATE TABLE public.billing (
    provider text NOT NULL CHECK (provider IN ('stripe', 'razorpay')),
    provider_subscription_id text NOT NULL,
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    plan text NOT NULL CHECK (plan IN ('pro', 'enterprise')),
    customer_id text,
    status text NOT NULL,
    currency text NOT NULL CHECK (currency IN ('USD', 'INR')),
    amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
    current_period_end timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (provider, provider_subscription_id)
);

CREATE INDEX billing_user_status_updated_idx
    ON public.billing (user_id, status, updated_at DESC);

ALTER TABLE public.billing ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.billing FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.billing TO authenticated;
CREATE POLICY billing_select_own ON public.billing FOR SELECT TO authenticated
    USING ((SELECT auth.uid()) = user_id);

CREATE TABLE public.billing_events (
    provider text NOT NULL CHECK (provider IN ('stripe', 'razorpay')),
    event_id text NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (provider, event_id)
);

ALTER TABLE public.billing_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.billing_events FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.billing IS 'Provider-verified subscription state, keyed to a Supabase Auth user. Only the backend writes this table.';
COMMENT ON TABLE public.billing_events IS 'Backend-only provider webhook idempotency records.';
NOTIFY pgrst, 'reload schema';
