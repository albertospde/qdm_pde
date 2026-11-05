-- Import automatico settimanale dei dati GfK in QDM (GitHub Actions + edge function qdm-gfk-import)
create table if not exists public.qdm_import_log (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  origine text not null default 'github',
  stato text not null,               -- ok | prova | nessun_dato | errore | avviato | in_corso
  week_key text,
  messaggio text,
  editori_non_mappati jsonb,
  dettagli jsonb
);
alter table public.qdm_import_log enable row level security;
create policy "lettura autenticati" on public.qdm_import_log for select to authenticated using (true);
create index if not exists qdm_import_log_created_idx on public.qdm_import_log (created_at desc);

-- Ultimi Excel scaricati da GfK (sovrascritti ogni settimana): servono all'app per rielaborare
-- la settimana dopo aver mappato editori nuovi
insert into storage.buckets (id, name, public) values ('qdm-gfk', 'qdm-gfk', false)
on conflict (id) do nothing;
create policy "qdm-gfk lettura autenticati" on storage.objects for select to authenticated using (bucket_id = 'qdm-gfk');

-- Chiave condivisa tra GitHub Actions (segreto QDM_GFK_CRON_KEY) e la edge function
insert into public.app_secrets (name, value)
values ('qdm_gfk_cron', encode(extensions.gen_random_bytes(24), 'hex'))
on conflict (name) do nothing;
