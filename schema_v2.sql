-- Run after schema.sql
alter table worker_profiles add column if not exists lat double precision,add column if not exists lng double precision,add column if not exists loc_at timestamptz,add column if not exists active_jobs int default 0,add column if not exists radius_km int default 50;
alter table active_problems add column if not exists ai jsonb;
create table if not exists vetting_sessions(id uuid primary key default gen_random_uuid(),user_id uuid references users(id),skill_id text references skills(id),questions jsonb,answers jsonb,ai_score numeric(5,2),ai_notes text,status text default 'issued',created_at timestamptz default now());
create table if not exists campaigns(id uuid primary key default gen_random_uuid(),sector_id text references sectors(id),audience text,sms text,email text,stats jsonb,status text default 'draft',created_by uuid,created_at timestamptz default now());
create table if not exists consents(user_id uuid primary key references users(id),sms_marketing bool default false,updated_at timestamptz default now());
