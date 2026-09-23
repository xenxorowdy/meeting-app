-- Run once with the backend's --migrate-users command using an owner DB connection.
-- auth.users remains managed by Supabase Auth.
CREATE TABLE public.users (
    id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    name text NOT NULL DEFAULT '',
    email text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.users FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.users TO authenticated;

CREATE POLICY users_select_own ON public.users FOR SELECT TO authenticated
    USING ((SELECT auth.uid()) = id);
CREATE POLICY users_insert_own ON public.users FOR INSERT TO authenticated
    WITH CHECK ((SELECT auth.uid()) = id);
CREATE POLICY users_update_own ON public.users FOR UPDATE TO authenticated
    USING ((SELECT auth.uid()) = id) WITH CHECK ((SELECT auth.uid()) = id);

COMMENT ON TABLE public.users IS 'Kesami user profiles. Identity and permissions come from Supabase Auth, not profile fields.';
NOTIFY pgrst, 'reload schema';
