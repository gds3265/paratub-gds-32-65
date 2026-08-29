-- Paratuberculose GDS 32-65 — Supabase multi-utilisateurs v1.2.13
create table if not exists public.ptb_records (
  dataset text not null,
  id text not null,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (dataset,id)
);
create index if not exists ptb_records_dataset_idx on public.ptb_records(dataset);

create table if not exists public.ptb_user_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  role text not null default 'read' check (role in ('read','write','admin')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create or replace function public.ptb_create_profile()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  insert into public.ptb_user_profiles(id,email,role,active)
  values(new.id,new.email,'read',true)
  on conflict (id) do update set email=excluded.email;
  return new;
end;$$;

drop trigger if exists ptb_on_auth_user_created on auth.users;
create trigger ptb_on_auth_user_created after insert or update of email on auth.users
for each row execute procedure public.ptb_create_profile();

alter table public.ptb_records enable row level security;
alter table public.ptb_user_profiles enable row level security;

drop policy if exists "ptb read authenticated" on public.ptb_records;
drop policy if exists "ptb write authenticated" on public.ptb_records;
drop policy if exists "profiles self or admin read" on public.ptb_user_profiles;
drop policy if exists "profiles admin update" on public.ptb_user_profiles;

create policy "ptb read authenticated" on public.ptb_records
for select to authenticated using (
  exists(select 1 from public.ptb_user_profiles p where p.id=auth.uid() and p.active=true)
);
create policy "ptb write authenticated" on public.ptb_records
for all to authenticated using (
  exists(select 1 from public.ptb_user_profiles p where p.id=auth.uid() and p.active=true and p.role in ('write','admin'))
) with check (
  exists(select 1 from public.ptb_user_profiles p where p.id=auth.uid() and p.active=true and p.role in ('write','admin'))
);
create policy "profiles self or admin read" on public.ptb_user_profiles
for select to authenticated using (
  id=auth.uid() or exists(select 1 from public.ptb_user_profiles p where p.id=auth.uid() and p.active=true and p.role='admin')
);
create policy "profiles admin update" on public.ptb_user_profiles
for update to authenticated using (
  exists(select 1 from public.ptb_user_profiles p where p.id=auth.uid() and p.active=true and p.role='admin')
) with check (true);

-- Après création de ton propre compte dans Authentication > Users,
-- rends-le administrateur une seule fois depuis l'éditeur SQL :
-- update public.ptb_user_profiles set role='admin' where email='TON_EMAIL';
