-- Eğitim platformu: üyelik, ilerleme ve korumalı ders içeriği
-- Supabase panelinde: SQL Editor > New query > bu dosyanın tamamını yapıştır > Run
-- Tekrar çalıştırılabilir (idempotent).

-- 1) İlerleme: her kullanıcının tek satırı, içinde ders bazlı { d, t } kayıtları
create table if not exists public.ilerleme (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  veri       jsonb not null default '{"dersler": {}, "son": null}'::jsonb,
  guncelleme timestamptz not null default now()
);

alter table public.ilerleme enable row level security;

drop policy if exists "kendi ilerlemesini okur" on public.ilerleme;
create policy "kendi ilerlemesini okur" on public.ilerleme
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "kendi ilerlemesini ekler" on public.ilerleme;
create policy "kendi ilerlemesini ekler" on public.ilerleme
  for insert to authenticated with check ((select auth.uid()) = user_id);

drop policy if exists "kendi ilerlemesini günceller" on public.ilerleme;
create policy "kendi ilerlemesini günceller" on public.ilerleme
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- anonim (giriş yapmamış) rolün tabloya hiçbir erişimi yok
revoke all on public.ilerleme from anon;
grant select, insert, update on public.ilerleme to authenticated;

-- 2) Ders içeriği: özel (public olmayan) depolama kovası
insert into storage.buckets (id, name, public)
values ('dersler', 'dersler', false)
on conflict (id) do update set public = false;

-- Sadece giriş yapmış kullanıcılar okuyabilir; yazma yalnızca service_role ile (yükleme betiği)
drop policy if exists "üyeler dersleri okur" on storage.objects;
create policy "üyeler dersleri okur" on storage.objects
  for select to authenticated using (bucket_id = 'dersler');
