-- Il pulsante "Aggiorna da GfK" chiede a GitHub di avviare il job tramite pg_net (asincrono).
-- Questa funzione legge la risposta di GitHub: se l'avvio è stato rifiutato, la riga 'avviato' di
-- qdm_import_log diventa 'errore' con un messaggio chiaro, così l'app chiude subito l'attesa.
create or replace function public.qdm_gfk_controlla_avvio()
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r record;
  v_status int;
  v_err text;
begin
  if auth.uid() is null then
    raise exception 'non autorizzato';
  end if;
  for r in
    select id, (dettagli->>'richiesta_net')::bigint as req
    from qdm_import_log
    where origine = 'app' and stato = 'avviato' and created_at > now() - interval '30 minutes'
  loop
    select status_code, error_msg into v_status, v_err from net._http_response where id = r.req;
    if v_status is null and v_err is null then
      continue;  -- GitHub non ha ancora risposto
    end if;
    if v_status between 200 and 299 then
      continue;  -- avvio accettato: l'esito lo scriverà il job
    end if;
    update qdm_import_log
       set stato = 'errore',
           messaggio = case
             when v_status in (401, 403, 404) then 'GitHub non ha avviato l''aggiornamento: il token non ha il permesso di avviare i job di qdm_pde (errore ' || v_status || ')'
             else 'GitHub non ha avviato l''aggiornamento (errore ' || coalesce(v_status::text, v_err) || ')'
           end
     where id = r.id;
  end loop;
  return 'ok';
end;
$function$;

revoke all on function public.qdm_gfk_controlla_avvio() from public, anon;
grant execute on function public.qdm_gfk_controlla_avvio() to authenticated;

-- I tre avvii del 2026-11-03 rifiutati da GitHub (403): segnati come errore
update public.qdm_import_log set stato = 'errore',
  messaggio = 'GitHub non ha avviato l''aggiornamento: il token non ha il permesso di avviare i job di qdm_pde (errore 403)'
where origine = 'app' and stato = 'avviato' and id in (6, 7, 8);
