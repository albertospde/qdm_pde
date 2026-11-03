-- Elenco delle promozioni di QDM, gestito dall'app (scheda "Mappatura") invece che scritto nel codice.
--   gruppo: raggruppamento nel grafico "Quote per gruppo" (es. 'PDE + PDE SERVICE'); vuoto = nessun gruppo
--   pde:    promozioni PDE (unite come 'PDE' nella Top 20 e nel trend annuale)
--   ordine: ordine dei gruppi nel grafico
create table if not exists public.qdm_promozioni (
  id bigserial primary key,
  nome text not null unique,
  gruppo text,
  pde boolean not null default false,
  ordine int not null default 100,
  created_at timestamptz not null default now()
);
alter table public.qdm_promozioni enable row level security;
create policy "solo autenticati" on public.qdm_promozioni for all to authenticated using (true) with check (true);

insert into public.qdm_promozioni (nome, gruppo, pde, ordine) values
  ('MONDADORI', 'GRANDI GRUPPI', false, 10), ('PROLIBRO', 'GRANDI GRUPPI', false, 10),
  ('GIUNTI', 'GRANDI GRUPPI', false, 10), ('FELTRINELLI', 'GRANDI GRUPPI', false, 10),
  ('PDE SERVIZI COMM. PER EDITORIA', 'PDE + PDE SERVICE', true, 20), ('PDE SERVICE', 'PDE + PDE SERVICE', true, 20),
  ('PROMEDI', 'PROMEDI + NW', false, 30), ('NW CONSULENZA MARKETING EDIT.', 'PROMEDI + NW', false, 30),
  ('EMME PROMOZIONE', 'EMMEPROMO + PROMOCOMIX', false, 40), ('PROMOCOMIX', 'EMMEPROMO + PROMOCOMIX', false, 40),
  ('LYR S.R.L. / ALI+LIBROMANIA', 'LYR S.R.L. / ALI+LIBROMANIA', false, 50),
  ('PEA ITALIA', 'PEA', false, 60),
  ('ALTRO', null, false, 100), ('AMAZON', null, false, 100), ('BIBLIOMANIE PROMOBIGS', null, false, 100),
  ('CORRAINI', null, false, 100), ('DIFFUSIONE SAN PAOLO', null, false, 100), ('DISTRIBOOK', null, false, 100),
  ('EDISES SRL', null, false, 100), ('EDIZ. MEDICO SCIENTIFICHE', null, false, 100), ('FRANCO ANGELI', null, false, 100),
  ('GIAPPICHELLI', null, false, 100), ('GIUFFRE', null, false, 100), ('GRIBAUDI', null, false, 100),
  ('L''IPPOCAMPO', null, false, 100), ('LATERZA', null, false, 100), ('LISCIANI', null, false, 100),
  ('LOESCHER', null, false, 100), ('LOGOS', null, false, 100), ('MACRO GRUPPO EDITORIALE SRL', null, false, 100),
  ('MAGGIOLI', null, false, 100), ('MCGRAW-HILL', null, false, 100), ('MURSIA', null, false, 100),
  ('NEWMEDI SRL', null, false, 100), ('PEARSON ITALIA SPA', null, false, 100), ('PROMEDIA ITALIA SERVICE', null, false, 100),
  ('RAFFAELLO', null, false, 100), ('SIMONE', null, false, 100), ('TASCHEN', null, false, 100), ('ZANICHELLI', null, false, 100)
on conflict (nome) do nothing;

-- Cambia il nome di una promozione ovunque: elenco, mappatura editori e dati già caricati
-- (recap, trend annuale, top 20). Il nome nuovo non deve esistere già.
create or replace function public.qdm_rinomina_promozione(p_vecchio text, p_nuovo text)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_nuovo text := upper(trim(coalesce(p_nuovo, '')));
  n_editori int;
begin
  if auth.uid() is null or coalesce(auth.jwt() -> 'user_metadata' ->> 'role', '') = 'agente' then
    raise exception 'non autorizzato';
  end if;
  if v_nuovo = '' then raise exception 'il nome nuovo è vuoto'; end if;
  if v_nuovo = p_vecchio then return 'nessun cambiamento'; end if;
  if exists (select 1 from qdm_promozioni where nome = v_nuovo) then
    raise exception 'esiste già una promozione "%"', v_nuovo;
  end if;
  update qdm_promozioni set nome = v_nuovo where nome = p_vecchio;
  if not found then raise exception 'promozione "%" non trovata', p_vecchio; end if;
  update editore_promozione set promo_2026 = v_nuovo where promo_2026 = p_vecchio;
  get diagnostics n_editori = row_count;
  update editore_promozione set promo_2025 = v_nuovo where promo_2025 = p_vecchio;
  update qdm_recap set promozione = v_nuovo where promozione = p_vecchio;
  update qdm_trend set promozione = v_nuovo where promozione = p_vecchio;
  update qdm_top20 set promozione = v_nuovo where promozione = p_vecchio;
  return format('rinominata in %s (%s editori)', v_nuovo, n_editori);
end;
$function$;

revoke all on function public.qdm_rinomina_promozione(text, text) from public, anon;
grant execute on function public.qdm_rinomina_promozione(text, text) to authenticated;
