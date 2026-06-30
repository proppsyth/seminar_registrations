create table if not exists seminar_registrations (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  branch text not null,
  org_name text not null,
  full_name text not null,
  full_name_normalized text not null,
  position text not null,
  training_date text not null,
  ack_purpose boolean not null default false,
  consent_general boolean not null default false,
  consent_sensitive boolean not null default false,
  ack_withdraw boolean not null default false
);

-- prevent the same person registering twice under the same org
create unique index if not exists seminar_registrations_org_name_uniq
  on seminar_registrations (org_name, full_name_normalized);

create index if not exists seminar_registrations_org_idx
  on seminar_registrations (org_name);

create index if not exists seminar_registrations_branch_idx
  on seminar_registrations (branch);

alter table seminar_registrations enable row level security;

-- service_role key bypasses RLS entirely (used by the server), so no public policies are defined.
