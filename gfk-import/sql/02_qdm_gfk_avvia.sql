-- Avvio dell'import GfK dal pulsante "Aggiorna da GfK" dell'app QDM (scelta di Alberto del 2026-11-03:
-- riusare il token GitHub già salvato per Giro Manager). Chiede a GitHub di avviare il workflow
-- gfk-import.yml con la settimana indicata e "reimporta" attivo; l'esito arriva in qdm_import_log.
create or replace function public.qdm_gfk_avvia(p_settimana text default null)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_token text;
  v_req bigint;
  v_sett text := nullif(trim(coalesce(p_settimana, '')), '');
begin
  if auth.uid() is null or coalesce(auth.jwt() -> 'user_metadata' ->> 'role', '') = 'agente' then
    raise exception 'non autorizzato';
  end if;
  if v_sett is not null and v_sett !~ '^\d{4}-\d{1,2}$' then
    raise exception 'settimana non valida (formato 2026-43)';
  end if;
  select value into v_token from app_secrets where name = 'github_giro_manager_token';
  if v_token is null or v_token = '' then
    raise exception 'token GitHub mancante';
  end if;
  select net.http_post(
    url := 'https://api.github.com/repos/albertospde/qdm_pde/actions/workflows/gfk-import.yml/dispatches',
    body := jsonb_build_object('ref', 'main', 'inputs', jsonb_build_object('settimana', coalesce(v_sett, ''), 'prova', 'false', 'forza', 'true')),
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_token,
      'Accept', 'application/vnd.github+json',
      'X-GitHub-Api-Version', '2022-11-28',
      'User-Agent', 'pde-supabase-qdm',
      'Content-Type', 'application/json'),
    timeout_milliseconds := 30000) into v_req;
  insert into qdm_import_log (origine, stato, week_key, messaggio, dettagli)
  values ('app', 'avviato', null,
          'Aggiornamento da GfK avviato' || coalesce(' per la ' || v_sett, ' per l''ultima settimana chiusa'),
          jsonb_build_object('richiesta_net', v_req, 'utente', auth.jwt() ->> 'email'));
  return 'avviato';
end;
$function$;

revoke all on function public.qdm_gfk_avvia(text) from public, anon;
grant execute on function public.qdm_gfk_avvia(text) to authenticated;
