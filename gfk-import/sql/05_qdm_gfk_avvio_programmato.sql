-- Avvio programmato dell'import GfK dal database (stesso schema di giro_prenotato_avvia): il calendario di
-- GitHub può ritardare o saltare i passaggi. pg_cron lavora in UTC: la funzione parte solo tra le 8 e le 13
-- italiane, sia con l'ora solare sia con quella legale. Il job esce subito se la settimana è già in QDM.
-- Dopo averlo applicato, togliere la voce "schedule" da .github/workflows/gfk-import.yml.
create or replace function public.qdm_gfk_avvia_programmato()
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_ora int := extract(hour from now() at time zone 'Europe/Rome');
  v_token text;
  v_req bigint;
begin
  if v_ora < 8 or v_ora > 13 then
    return 'fuori orario: nessun avvio';
  end if;
  select value into v_token from app_secrets where name = 'github_giro_manager_token';
  if v_token is null or v_token = '' then
    return 'token GitHub mancante';
  end if;
  select net.http_post(
    url := 'https://api.github.com/repos/albertospde/qdm_pde/actions/workflows/gfk-import.yml/dispatches',
    body := '{"ref":"main"}'::jsonb,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_token,
      'Accept', 'application/vnd.github+json',
      'X-GitHub-Api-Version', '2022-11-28',
      'User-Agent', 'pde-supabase-cron',
      'Content-Type', 'application/json'),
    timeout_milliseconds := 30000) into v_req;
  return 'avvio richiesto (richiesta net ' || v_req || ')';
end;
$function$;

revoke all on function public.qdm_gfk_avvia_programmato() from public, anon, authenticated;

select cron.schedule('qdm-gfk-avvio-giovedi', '0 6-12 * * 4', 'select public.qdm_gfk_avvia_programmato()');
