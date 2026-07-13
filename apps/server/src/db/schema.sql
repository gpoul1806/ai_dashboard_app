-- "My Day" Supabase schema (v1). Apply with the SQL editor or supabase db push.
create extension if not exists pg_trgm;

create table if not exists features (
  id          text primary key,
  slug        text unique not null,
  name        text not null,
  description text not null,
  definition  jsonb not null,
  version     int not null default 1,
  created_at  timestamptz not null default now()
);
create index if not exists features_description_trgm
  on features using gin (description gin_trgm_ops);

create table if not exists generated_components (
  id           text primary key, -- registry key, e.g. 'Image@1'
  name         text not null,
  version      int not null,
  description  text not null default '',
  props_schema jsonb not null default '{}',
  source       text not null,
  built_js     text not null,
  created_at   timestamptz not null default now()
);

create table if not exists capabilities (
  id               text primary key, -- key, e.g. 'giphy-search@1'
  name             text not null,
  version          int not null,
  spec             jsonb not null,
  handler_source   text not null default '',
  domain_allowlist text[] not null default '{}',
  review_required  boolean not null default true,
  approved         boolean not null default false,
  created_at       timestamptz not null default now()
);

-- host-injected only; never readable by generated code
create table if not exists capability_secrets (
  capability_id text not null,
  key_name      text not null,
  value         text not null,
  primary key (capability_id, key_name)
);

create table if not exists capability_data (
  capability_id text not null,
  user_id       text not null,
  k             text not null,
  v             jsonb,
  primary key (capability_id, user_id, k)
);

create table if not exists user_layouts (
  id         uuid primary key default gen_random_uuid(),
  user_id    text not null,
  feature_id text not null references features(id),
  position   int not null default 0,
  placement  text not null default 'flow',
  created_at timestamptz not null default now()
);

create table if not exists widget_data (
  id         uuid primary key default gen_random_uuid(),
  user_id    text not null,
  feature_id text not null references features(id),
  "row"      jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists generation_log (
  id           bigint generated always as identity primary key,
  request_text text not null,
  tier         text not null,
  cache_hit    boolean not null default false,
  success      boolean not null,
  retries      int not null default 0,
  tokens       int not null default 0,
  created_at   timestamptz not null default now()
);

-- Normalized request similarity for the feature cache.
create or replace function find_similar_features(query text, threshold real, match_limit int)
returns table (
  id text, slug text, name text, description text,
  definition jsonb, version int, created_at timestamptz, sim real
)
language sql stable as $$
  select f.id, f.slug, f.name, f.description, f.definition, f.version, f.created_at,
         similarity(f.description, query) as sim
  from features f
  where similarity(f.description, query) > threshold
  order by sim desc
  limit match_limit;
$$;
