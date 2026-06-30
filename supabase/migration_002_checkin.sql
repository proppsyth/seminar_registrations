-- Split name into parts, add contact info, check-in & substitution support.

alter table seminar_registrations
  add column if not exists title text,
  add column if not exists first_name text,
  add column if not exists last_name text,
  add column if not exists phone text,
  add column if not exists email text,
  add column if not exists is_checked_in boolean not null default false,
  add column if not exists checked_in_at timestamptz,
  add column if not exists replaces_registration_id uuid references seminar_registrations(id) on delete set null,
  add column if not exists is_replaced boolean not null default false;

-- Backfill existing rows: best-effort split of full_name into first/last, title left blank.
update seminar_registrations
set
  first_name = coalesce(first_name, split_part(full_name, ' ', 1)),
  last_name = coalesce(last_name, nullif(substring(full_name from position(' ' in full_name) + 1), ''))
where first_name is null;

-- Drop the old per-org registration cap unique index (cap now applies only at check-in).
drop index if exists seminar_registrations_org_name_uniq;

-- New duplicate check: same org + same title/first/last name (normalized).
create unique index if not exists seminar_registrations_org_person_uniq
  on seminar_registrations (org_name, full_name_normalized);

create index if not exists seminar_registrations_checked_in_idx
  on seminar_registrations (org_name, is_checked_in);
