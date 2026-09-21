-- ╔══════════════════════════════════════════════════════════════════╗
-- ║ Blue Ocean — v6.9.72: GitHub Actions render lane bridge           ║
-- ║ The app's CF-rescue chain dispatches a URL to the render lane     ║
-- ║ (real headless Camoufox/Chromium on GitHub's free runners) via    ║
-- ║ repository_dispatch. Results land on the render-cache branch:     ║
-- ║   meta/<sha1(url)>.json + dom/<sha1(url)>.html (done scans only)  ║
-- ║ The browser fetches those DIRECTLY (raw.githubusercontent serves  ║
-- ║ CORS *) — only the PAT call must run server-side. The PAT lives   ║
-- ║ in Vault (bo_actions_render_token), never in the client bundle.   ║
-- ╚══════════════════════════════════════════════════════════════════╝

create extension if not exists pgcrypto with schema extensions;

-- ── Read the GitHub PAT from Vault (service-role only) ─────────────
create or replace function public._actions_render_token()
returns text
language sql
stable
security definer
set search_path = 'public', 'vault'
as $$
  select decrypted_secret
  from vault.decrypted_secrets
  where name = 'bo_actions_render_token'
  limit 1
$$;

-- ── sha1(url) exactly as scripts/render_lane.py computes it ────────
-- (printf '%s' "$U" | sha1sum → raw bytes, no trailing newline)
create or replace function public._render_sha(p_url text)
returns text
language sql
stable
as $$
  select encode(extensions.digest(p_url, 'sha1'), 'hex')
$$;

-- ── Submit a URL to the render lane ────────────────────────────────
-- POST /repos/{owner}/{repo}/dispatches → 204 No Content. One-shot:
-- success means GitHub queued the run; the client then polls the
-- render-cache branch directly (raw.githubusercontent, CORS-enabled).
-- Returns {rid, sha} — sha feeds the client's meta/dom polling.
create or replace function public.rpc_render_dispatch(p_url text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = 'net', 'public'
as $$
declare
  v_rid bigint;
  v_tok text;
  v_sha text;
begin
  if p_url is null or length(p_url) > 2000 then
    return jsonb_build_object('error', 'bad-url');
  end if;
  if not public._fetch_url_allowed(p_url) then
    return jsonb_build_object('error', 'url-not-allowed');
  end if;
  v_tok := public._actions_render_token();
  if v_tok is null or length(v_tok) < 20 then
    return jsonb_build_object('error', 'key-not-configured');
  end if;
  v_sha := public._render_sha(p_url);
  select net.http_post(
      'https://api.github.com/repos/devso3939/Blue-Ocean/dispatches',
      jsonb_build_object(
        'event_type', 'render-lane',
        'client_payload', jsonb_build_object('url', p_url)
      ),
      '{}'::jsonb,
      jsonb_build_object(
        'Authorization', 'Bearer ' || v_tok,
        'Accept', 'application/vnd.github+json',
        'User-Agent', 'Blue-Ocean-Render-Lane',
        'Content-Type', 'application/json'
      ),
      20000
    ) into v_rid;
  if v_rid is null then
    return jsonb_build_object('error', 'submit-failed');
  end if;
  return jsonb_build_object('rid', v_rid, 'sha', v_sha);
end $$;

revoke all on function public.rpc_render_dispatch(text) from public, anon, authenticated;
grant execute on function public.rpc_render_dispatch(text) to anon, authenticated;

-- ── Retire the two-in-one poll functions from the first draft ──────
-- (pg_net commit rule violation: they submitted and polled inside one
-- transaction, so the worker never saw the request. The browser now
-- polls raw.githubusercontent directly — simpler and correct.)
drop function if exists public.rpc_render_meta(text);
drop function if exists public.rpc_render_dom(text);
