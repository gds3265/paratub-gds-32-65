-- Paratuberculose GDS 32-65 — schéma simple v1
-- Table générique pour synchroniser la base locale de l'application.
create table if not exists public.ptb_records (
  dataset text not null,
  id text not null,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (dataset,id)
);

create index if not exists ptb_records_dataset_idx on public.ptb_records(dataset);

alter table public.ptb_records enable row level security;

-- VERSION SIMPLE POUR UN PROJET SUPABASE DÉDIÉ À CETTE APPLICATION.
-- À remplacer par une politique authentifiée si plusieurs utilisateurs/organisations partagent le projet.
drop policy if exists "ptb read anon" on public.ptb_records;
drop policy if exists "ptb write anon" on public.ptb_records;
create policy "ptb read anon" on public.ptb_records for select to anon using (true);
create policy "ptb write anon" on public.ptb_records for all to anon using (true) with check (true);
