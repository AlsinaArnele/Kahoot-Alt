-- QUIZ ARENA Supabase-only live backend
-- Run this entire file in Supabase SQL Editor.
-- It is intentionally idempotent and safe to re-run.

create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- Tables
-- -----------------------------------------------------------------------------

create table if not exists public.games (
  id uuid primary key default gen_random_uuid(),
  game_pin text not null unique,
  host_token text not null default encode(gen_random_bytes(24), 'hex'),
  status text not null default 'LOBBY',
  current_round text,
  default_timer integer not null default 20,
  question_timer_limit integer not null default 20,
  question_started_at timestamptz,
  precountdown_started_at timestamptz,
  state_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint games_status_check check (status in ('LOBBY','PRECOUNTDOWN','QUESTION','REVEAL','LEADERBOARD','FINISHED')),
  constraint games_default_timer_check check (default_timer between 3 and 300),
  constraint games_question_timer_limit_check check (question_timer_limit between 3 and 300)
);

alter table public.games add column if not exists host_token text default encode(gen_random_bytes(24), 'hex');
update public.games set host_token = encode(gen_random_bytes(24), 'hex') where host_token is null or host_token = '';
alter table public.games alter column host_token set default encode(gen_random_bytes(24), 'hex');
alter table public.games alter column host_token set not null;
alter table public.games add column if not exists question_timer_limit integer not null default 20;
alter table public.games add column if not exists question_started_at timestamptz;
alter table public.games add column if not exists precountdown_started_at timestamptz;
alter table public.games add column if not exists state_version integer not null default 1;

create table if not exists public.config (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games(id) on delete cascade,
  key text not null,
  value text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (game_id, key)
);

create table if not exists public.questions (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games(id) on delete cascade,
  sort_order integer not null default 0,
  round text not null,
  question text not null default '',
  option_a text not null default '',
  option_b text not null default '',
  option_c text not null default '',
  option_d text not null default '',
  correct text not null,
  image_url text not null default '',
  time_limit integer,
  points integer,
  explanation text not null default '',
  category text not null default '',
  difficulty text not null default '',
  double_points boolean not null default false,
  fun_fact text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint questions_correct_check check (correct in ('A','B','C','D')),
  constraint questions_time_limit_check check (time_limit is null or time_limit between 3 and 300),
  constraint questions_points_check check (points is null or points between 1 and 100000),
  unique (game_id, round)
);

alter table public.questions add column if not exists sort_order integer not null default 0;

create table if not exists public.players (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games(id) on delete cascade,
  player_id text not null default gen_random_uuid()::text,
  nickname text not null,
  total_score integer not null default 0,
  streak integer not null default 0,
  joined_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  is_active boolean not null default true,
  avatar_color text not null default '#4ade80',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint players_nickname_len check (char_length(trim(nickname)) between 1 and 20),
  unique (game_id, player_id)
);

create unique index if not exists players_unique_nickname_ci on public.players (game_id, lower(nickname));
create index if not exists players_game_score_idx on public.players (game_id, total_score desc, joined_at asc);

create table if not exists public.submissions (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games(id) on delete cascade,
  round text not null,
  player_id text not null,
  nickname text not null default '',
  choice text not null,
  time_remaining numeric not null default 0,
  points_awarded integer not null default 0,
  is_correct boolean not null default false,
  submitted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint submissions_choice_check check (choice in ('A','B','C','D','TIMEOUT')),
  unique (game_id, round, player_id)
);

create index if not exists submissions_game_round_idx on public.submissions (game_id, round, submitted_at asc);
create index if not exists submissions_player_idx on public.submissions (game_id, player_id);

create table if not exists public.game_events (
  id bigserial primary key,
  game_id uuid not null references public.games(id) on delete cascade,
  event_type text not null,
  round text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists game_events_game_created_idx on public.game_events (game_id, created_at desc);

-- -----------------------------------------------------------------------------
-- Updated-at trigger
-- -----------------------------------------------------------------------------

create or replace function public.qa_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_games_updated_at on public.games;
create trigger trg_games_updated_at before update on public.games
for each row execute function public.qa_set_updated_at();

drop trigger if exists trg_config_updated_at on public.config;
create trigger trg_config_updated_at before update on public.config
for each row execute function public.qa_set_updated_at();

drop trigger if exists trg_questions_updated_at on public.questions;
create trigger trg_questions_updated_at before update on public.questions
for each row execute function public.qa_set_updated_at();

drop trigger if exists trg_players_updated_at on public.players;
create trigger trg_players_updated_at before update on public.players
for each row execute function public.qa_set_updated_at();

-- -----------------------------------------------------------------------------
-- RLS: direct browser reads are intentionally narrow.
-- Writes happen through SECURITY DEFINER RPCs below.
-- -----------------------------------------------------------------------------

alter table public.games enable row level security;
alter table public.config enable row level security;
alter table public.questions enable row level security;
alter table public.players enable row level security;
alter table public.submissions enable row level security;
alter table public.game_events enable row level security;

drop policy if exists games_public_read on public.games;
create policy games_public_read on public.games for select to anon using (true);

drop policy if exists config_public_read on public.config;
create policy config_public_read on public.config for select to anon using (true);

drop policy if exists players_public_read on public.players;
create policy players_public_read on public.players for select to anon using (true);

drop policy if exists game_events_public_read on public.game_events;
create policy game_events_public_read on public.game_events for select to anon using (true);

-- No direct public read policy on questions/submissions. Host/player use RPC snapshots.

grant usage on schema public to anon;
grant select on public.games, public.config, public.players, public.game_events to anon;

-- -----------------------------------------------------------------------------
-- Realtime publication
-- -----------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'games'
    ) then
      execute 'alter publication supabase_realtime add table public.games';
    end if;

    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'players'
    ) then
      execute 'alter publication supabase_realtime add table public.players';
    end if;

    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'game_events'
    ) then
      execute 'alter publication supabase_realtime add table public.game_events';
    end if;
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- Helper functions
-- -----------------------------------------------------------------------------

create or replace function public.qa_clean_pin(p_game_pin text)
returns text
language sql
immutable
as $$
  select regexp_replace(coalesce(p_game_pin, ''), '[^0-9A-Za-z]', '', 'g')
$$;

create or replace function public.qa_clean_nickname(p_nickname text)
returns text
language sql
immutable
as $$
  select left(regexp_replace(trim(coalesce(p_nickname, '')), '\s+', ' ', 'g'), 20)
$$;

create or replace function public.qa_is_blocked_nickname(p_nickname text)
returns boolean
language plpgsql
immutable
as $$
declare
  v text := lower(coalesce(p_nickname, ''));
  bad text;
  bad_words text[] := array[
    'fuck','shit','bitch','asshole','cunt','nigger','nigga','faggot','slut','whore','porn','sex','dick','pussy','cock','hitler','nazi'
  ];
begin
  foreach bad in array bad_words loop
    if position(bad in v) > 0 then
      return true;
    end if;
  end loop;
  return false;
end;
$$;

create or replace function public.qa_avatar_color(p_seed text)
returns text
language plpgsql
immutable
as $$
declare
  palette text[] := array['#4ade80','#22c55e','#84cc16','#06b6d4','#38bdf8','#a78bfa','#f472b6','#fb7185','#f59e0b','#facc15'];
  idx integer;
begin
  idx := (abs(hashtext(coalesce(p_seed, 'arena'))) % array_length(palette, 1)) + 1;
  return palette[idx];
end;
$$;

create or replace function public.qa_config_bool(p_game_id uuid, p_key text, p_default boolean default false)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v text;
begin
  select c.value into v
  from public.config c
  where c.game_id = p_game_id
    and lower(regexp_replace(c.key, '[^a-zA-Z0-9]', '', 'g')) = lower(regexp_replace(p_key, '[^a-zA-Z0-9]', '', 'g'))
  limit 1;

  if v is null then return p_default; end if;
  return upper(trim(v)) in ('TRUE','YES','Y','1','ON','ENABLE','ENABLED');
end;
$$;

create or replace function public.qa_emit_event(p_game_id uuid, p_event_type text, p_round text default null, p_payload jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.game_events(game_id, event_type, round, payload)
  values (p_game_id, upper(coalesce(p_event_type, 'EVENT')), p_round, coalesce(p_payload, '{}'::jsonb));
end;
$$;

create or replace function public.qa_leaderboard_json(p_game_id uuid, p_limit integer default 10)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with ranked as (
    select
      p.player_id,
      p.nickname,
      p.total_score,
      p.streak,
      p.avatar_color,
      p.is_active,
      p.joined_at,
      rank() over (order by p.total_score desc, p.joined_at asc) as rank
    from public.players p
    where p.game_id = p_game_id
  ), limited as (
    select * from ranked order by rank asc, joined_at asc limit greatest(1, coalesce(p_limit, 10))
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'playerId', player_id,
    'nickname', nickname,
    'totalScore', total_score,
    'streak', streak,
    'avatarColor', avatar_color,
    'isActive', is_active,
    'rank', rank
  ) order by rank asc, joined_at asc), '[]'::jsonb)
  from limited;
$$;

create or replace function public.qa_player_rank(p_game_id uuid, p_player_id text)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  with ranked as (
    select player_id, rank() over (order by total_score desc, joined_at asc) as rank
    from public.players
    where game_id = p_game_id
  )
  select rank from ranked where player_id = p_player_id limit 1;
$$;

create or replace function public.qa_question_json(p_game_id uuid, p_round text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    jsonb_build_object(
      'id', q.id,
      'sortOrder', q.sort_order,
      'round', q.round,
      'question', q.question,
      'optionA', q.option_a,
      'optionB', q.option_b,
      'optionC', q.option_c,
      'optionD', q.option_d,
      'correct', q.correct,
      'imageUrl', q.image_url,
      'timeLimit', q.time_limit,
      'points', q.points,
      'explanation', q.explanation,
      'category', q.category,
      'difficulty', q.difficulty,
      'doublePoints', q.double_points,
      'funFact', q.fun_fact
    ), '{}'::jsonb)
  from public.questions q
  where q.game_id = p_game_id and q.round = p_round
  limit 1;
$$;

create or replace function public.qa_answer_stats_json(p_game_id uuid, p_round text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'A', coalesce(sum(case when choice = 'A' then 1 else 0 end), 0),
    'B', coalesce(sum(case when choice = 'B' then 1 else 0 end), 0),
    'C', coalesce(sum(case when choice = 'C' then 1 else 0 end), 0),
    'D', coalesce(sum(case when choice = 'D' then 1 else 0 end), 0),
    'total', coalesce(sum(case when choice in ('A','B','C','D') then 1 else 0 end), 0)
  )
  from public.submissions
  where game_id = p_game_id and round = p_round;
$$;

create or replace function public.qa_config_json(p_game_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
  from public.config
  where game_id = p_game_id;
$$;

-- -----------------------------------------------------------------------------
-- Public RPCs called from browser with anon key
-- -----------------------------------------------------------------------------

create or replace function public.qa_join_game(p_game_pin text, p_nickname text, p_existing_player_id text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_game public.games%rowtype;
  v_nick text;
  v_player public.players%rowtype;
  v_player_id text;
begin
  select * into v_game
  from public.games
  where game_pin = public.qa_clean_pin(p_game_pin)
  limit 1;

  if v_game.id is null then
    raise exception 'Game PIN not found.';
  end if;

  v_nick := public.qa_clean_nickname(p_nickname);
  if char_length(v_nick) = 0 then
    raise exception 'Nickname is required.';
  end if;
  if char_length(v_nick) > 20 then
    raise exception 'Nickname must be 20 characters or fewer.';
  end if;
  if public.qa_is_blocked_nickname(v_nick) then
    raise exception 'Please choose a different nickname.';
  end if;

  if coalesce(p_existing_player_id, '') <> '' then
    select * into v_player
    from public.players
    where game_id = v_game.id and player_id = p_existing_player_id
    limit 1;

    if v_player.id is not null then
      update public.players
      set last_seen = now(), is_active = true
      where id = v_player.id
      returning * into v_player;

      return jsonb_build_object(
        'ok', true,
        'reconnected', true,
        'gameId', v_game.id,
        'gamePin', v_game.game_pin,
        'player', jsonb_build_object(
          'playerId', v_player.player_id,
          'nickname', v_player.nickname,
          'totalScore', v_player.total_score,
          'streak', v_player.streak,
          'rank', public.qa_player_rank(v_game.id, v_player.player_id),
          'avatarColor', v_player.avatar_color
        )
      );
    end if;
  end if;

  if v_game.status not in ('LOBBY','PRECOUNTDOWN') then
    raise exception 'The arena has already kicked off.';
  end if;

  v_player_id := gen_random_uuid()::text;

  insert into public.players(game_id, player_id, nickname, total_score, streak, avatar_color, last_seen, is_active)
  values (v_game.id, v_player_id, v_nick, 0, 0, public.qa_avatar_color(v_nick), now(), true)
  returning * into v_player;

  perform public.qa_emit_event(v_game.id, 'JOIN', v_game.current_round, jsonb_build_object(
    'playerId', v_player.player_id,
    'nickname', v_player.nickname,
    'avatarColor', v_player.avatar_color
  ));

  update public.games
  set state_version = state_version + 1
  where id = v_game.id;

  return jsonb_build_object(
    'ok', true,
    'reconnected', false,
    'gameId', v_game.id,
    'gamePin', v_game.game_pin,
    'player', jsonb_build_object(
      'playerId', v_player.player_id,
      'nickname', v_player.nickname,
      'totalScore', v_player.total_score,
      'streak', v_player.streak,
      'rank', public.qa_player_rank(v_game.id, v_player.player_id),
      'avatarColor', v_player.avatar_color
    )
  );
exception
  when unique_violation then
    raise exception 'That nickname is already taken.';
end;
$$;

create or replace function public.qa_heartbeat(p_game_pin text, p_player_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_game_id uuid;
  v_count integer;
begin
  select id into v_game_id from public.games where game_pin = public.qa_clean_pin(p_game_pin) limit 1;
  if v_game_id is null then raise exception 'Game PIN not found.'; end if;

  update public.players
  set last_seen = now(), is_active = true
  where game_id = v_game_id and player_id = p_player_id;
  get diagnostics v_count = row_count;

  return jsonb_build_object('ok', v_count > 0, 'serverTime', now());
end;
$$;

create or replace function public.qa_player_snapshot(p_game_pin text, p_player_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_game public.games%rowtype;
  v_player public.players%rowtype;
  v_submission public.submissions%rowtype;
  v_rank integer;
  v_show_results boolean;
begin
  select * into v_game
  from public.games
  where game_pin = public.qa_clean_pin(p_game_pin)
  limit 1;
  if v_game.id is null then raise exception 'Game PIN not found.'; end if;

  select * into v_player
  from public.players
  where game_id = v_game.id and player_id = p_player_id
  limit 1;
  if v_player.id is null then raise exception 'Player not found. Please rejoin.'; end if;

  update public.players set last_seen = now(), is_active = true where id = v_player.id;
  select * into v_player from public.players where id = v_player.id;

  select * into v_submission
  from public.submissions
  where game_id = v_game.id and round = v_game.current_round and player_id = p_player_id
  limit 1;

  v_rank := public.qa_player_rank(v_game.id, p_player_id);
  v_show_results := v_game.status in ('REVEAL','LEADERBOARD','FINISHED');

  return jsonb_build_object(
    'ok', true,
    'serverTime', now(),
    'game', jsonb_build_object(
      'id', v_game.id,
      'gamePin', v_game.game_pin,
      'status', v_game.status,
      'currentRound', v_game.current_round,
      'questionStartedAt', v_game.question_started_at,
      'precountdownStartedAt', v_game.precountdown_started_at,
      'questionTimerLimit', v_game.question_timer_limit,
      'stateVersion', v_game.state_version
    ),
    'player', jsonb_build_object(
      'playerId', v_player.player_id,
      'nickname', v_player.nickname,
      'totalScore', v_player.total_score,
      'streak', v_player.streak,
      'rank', v_rank,
      'avatarColor', v_player.avatar_color
    ),
    'answer', case when v_submission.id is null then null else jsonb_build_object(
      'submitted', true,
      'choice', v_submission.choice,
      'pointsAwarded', case when v_show_results then v_submission.points_awarded else null end,
      'isCorrect', case when v_show_results then v_submission.is_correct else null end,
      'submittedAt', v_submission.submitted_at
    ) end
  );
end;
$$;

create or replace function public.qa_host_snapshot(p_game_pin text, p_host_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_game public.games%rowtype;
  v_players jsonb;
  v_active_count integer;
  v_stats jsonb;
begin
  select * into v_game
  from public.games
  where game_pin = public.qa_clean_pin(p_game_pin)
  limit 1;

  if v_game.id is null then
    raise exception 'Game PIN not found.';
  end if;
  if coalesce(p_host_token, '') <> v_game.host_token then
    raise exception 'Invalid host token.';
  end if;

  select count(*) into v_active_count
  from public.players
  where game_id = v_game.id
    and is_active = true
    and last_seen > now() - interval '5 minutes';

  select coalesce(jsonb_agg(jsonb_build_object(
    'playerId', p.player_id,
    'nickname', p.nickname,
    'totalScore', p.total_score,
    'streak', p.streak,
    'joinedAt', p.joined_at,
    'lastSeen', p.last_seen,
    'isActive', p.is_active,
    'avatarColor', p.avatar_color,
    'rank', public.qa_player_rank(v_game.id, p.player_id)
  ) order by p.joined_at asc), '[]'::jsonb)
  into v_players
  from public.players p
  where p.game_id = v_game.id;

  v_stats := public.qa_answer_stats_json(v_game.id, v_game.current_round);

  return jsonb_build_object(
    'ok', true,
    'serverTime', now(),
    'game', jsonb_build_object(
      'id', v_game.id,
      'gamePin', v_game.game_pin,
      'status', v_game.status,
      'currentRound', v_game.current_round,
      'defaultTimer', v_game.default_timer,
      'questionTimerLimit', v_game.question_timer_limit,
      'questionStartedAt', v_game.question_started_at,
      'precountdownStartedAt', v_game.precountdown_started_at,
      'stateVersion', v_game.state_version
    ),
    'config', public.qa_config_json(v_game.id),
    'question', public.qa_question_json(v_game.id, v_game.current_round),
    'players', v_players,
    'activePlayerCount', v_active_count,
    'answerStats', v_stats,
    'leaderboard', public.qa_leaderboard_json(v_game.id, 10)
  );
end;
$$;

create or replace function public.qa_submit_answer(p_game_pin text, p_player_id text, p_round text, p_choice text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_game public.games%rowtype;
  v_player public.players%rowtype;
  v_question public.questions%rowtype;
  v_choice text := upper(trim(coalesce(p_choice, '')));
  v_timer integer;
  v_elapsed numeric;
  v_time_remaining numeric;
  v_correct boolean := false;
  v_max_points integer;
  v_awarded integer := 0;
  v_base integer := 0;
  v_streak_before integer := 0;
  v_new_streak integer := 0;
  v_bonus integer := 0;
  v_active_count integer := 0;
  v_answered_count integer := 0;
  v_revealed boolean := false;
begin
  select * into v_game
  from public.games
  where game_pin = public.qa_clean_pin(p_game_pin)
  for update;

  if v_game.id is null then raise exception 'Game PIN not found.'; end if;
  if v_game.status <> 'QUESTION' then raise exception 'Answers are only accepted while the arena is on a question.'; end if;
  if coalesce(p_round, '') <> coalesce(v_game.current_round, '') then raise exception 'That answer is for the wrong round.'; end if;
  if v_choice not in ('A','B','C','D') then raise exception 'Choose A, B, C, or D.'; end if;
  if v_game.question_started_at is null then raise exception 'The question timer has not started.'; end if;

  select * into v_player
  from public.players
  where game_id = v_game.id and player_id = p_player_id and is_active = true
  limit 1;
  if v_player.id is null then raise exception 'Player not found. Please rejoin.'; end if;

  select * into v_question
  from public.questions
  where game_id = v_game.id and round = v_game.current_round
  limit 1;
  if v_question.id is null then raise exception 'Question not found.'; end if;

  v_timer := coalesce(v_question.time_limit, v_game.question_timer_limit, v_game.default_timer, 20);
  v_elapsed := extract(epoch from (now() - v_game.question_started_at));
  v_time_remaining := greatest(0, v_timer - v_elapsed);

  -- Small network grace keeps honest last-second taps from getting dropped before the browser can send.
  if v_elapsed > v_timer + 1.25 then
    raise exception 'Time is up.';
  end if;

  v_correct := v_choice = v_question.correct;
  v_streak_before := coalesce(v_player.streak, 0);

  if v_correct then
    v_max_points := coalesce(v_question.points, 1000);
    v_base := round(v_max_points * (0.5 + 0.5 * (v_time_remaining / greatest(v_timer, 1))));
    if public.qa_config_bool(v_game.id, 'EnableStreakBonus', false) then
      v_bonus := least(v_streak_before * 25, 250);
    end if;
    v_awarded := v_base + v_bonus;
    if coalesce(v_question.double_points, false) then
      v_awarded := v_awarded * 2;
    end if;
    v_new_streak := v_streak_before + 1;
  else
    v_awarded := 0;
    v_new_streak := 0;
  end if;

  insert into public.submissions(game_id, round, player_id, nickname, choice, time_remaining, points_awarded, is_correct, submitted_at)
  values (v_game.id, v_game.current_round, v_player.player_id, v_player.nickname, v_choice, round(v_time_remaining::numeric, 3), v_awarded, v_correct, now());

  update public.players
  set total_score = total_score + v_awarded,
      streak = v_new_streak,
      last_seen = now(),
      is_active = true
  where id = v_player.id;

  select count(*) into v_active_count
  from public.players
  where game_id = v_game.id
    and is_active = true
    and last_seen > now() - interval '5 minutes';

  select count(*) into v_answered_count
  from public.submissions
  where game_id = v_game.id
    and round = v_game.current_round
    and choice in ('A','B','C','D');

  perform public.qa_emit_event(v_game.id, 'ANSWER', v_game.current_round, jsonb_build_object(
    'playerId', v_player.player_id,
    'choice', v_choice,
    'answeredCount', v_answered_count,
    'activePlayerCount', v_active_count
  ));

  if v_active_count > 0 and v_answered_count >= v_active_count then
    update public.games
    set status = 'REVEAL', state_version = state_version + 1
    where id = v_game.id and status = 'QUESTION' and current_round = v_game.current_round;
    if found then
      v_revealed := true;
      perform public.qa_emit_event(v_game.id, 'REVEAL', v_game.current_round, jsonb_build_object('reason', 'all_answered'));
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'accepted', true,
    'autoRevealed', v_revealed,
    'timeRemaining', round(v_time_remaining::numeric, 3),
    'choice', v_choice,
    'round', v_game.current_round
  );
exception
  when unique_violation then
    raise exception 'You already answered this round.';
end;
$$;

create or replace function public.qa_reveal_round(p_game_pin text, p_host_token text, p_reason text default 'host')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_game public.games%rowtype;
begin
  select * into v_game
  from public.games
  where game_pin = public.qa_clean_pin(p_game_pin)
  for update;

  if v_game.id is null then raise exception 'Game PIN not found.'; end if;
  if coalesce(p_host_token, '') <> v_game.host_token then raise exception 'Invalid host token.'; end if;

  if v_game.status = 'QUESTION' then
    insert into public.submissions(game_id, round, player_id, nickname, choice, time_remaining, points_awarded, is_correct, submitted_at)
    select v_game.id, v_game.current_round, p.player_id, p.nickname, 'TIMEOUT', 0, 0, false, now()
    from public.players p
    where p.game_id = v_game.id
      and p.is_active = true
      and p.last_seen > now() - interval '5 minutes'
      and not exists (
        select 1 from public.submissions s
        where s.game_id = v_game.id and s.round = v_game.current_round and s.player_id = p.player_id
      )
    on conflict do nothing;

    update public.players p
    set streak = 0, last_seen = p.last_seen
    where p.game_id = v_game.id
      and p.is_active = true
      and exists (
        select 1 from public.submissions s
        where s.game_id = v_game.id and s.round = v_game.current_round and s.player_id = p.player_id and s.choice = 'TIMEOUT'
      );

    update public.games
    set status = 'REVEAL', state_version = state_version + 1
    where id = v_game.id;

    perform public.qa_emit_event(v_game.id, 'REVEAL', v_game.current_round, jsonb_build_object('reason', coalesce(p_reason, 'host')));
  elsif v_game.status = 'PRECOUNTDOWN' then
    update public.games set status = 'REVEAL', state_version = state_version + 1 where id = v_game.id;
    perform public.qa_emit_event(v_game.id, 'REVEAL', v_game.current_round, jsonb_build_object('reason', coalesce(p_reason, 'host')));
  end if;

  return public.qa_host_snapshot(v_game.game_pin, p_host_token);
end;
$$;

create or replace function public.qa_advance_game(p_game_pin text, p_host_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_game public.games%rowtype;
  v_round text;
  v_next_round text;
  v_timer integer;
  v_event text;
begin
  select * into v_game
  from public.games
  where game_pin = public.qa_clean_pin(p_game_pin)
  for update;

  if v_game.id is null then raise exception 'Game PIN not found.'; end if;
  if coalesce(p_host_token, '') <> v_game.host_token then raise exception 'Invalid host token.'; end if;

  if v_game.status = 'LOBBY' then
    select q.round into v_round
    from public.questions q
    where q.game_id = v_game.id
    order by q.sort_order asc, q.round asc
    limit 1;
    if v_round is null then raise exception 'No questions found. Sync your Sheet first.'; end if;

    update public.games
    set status = 'PRECOUNTDOWN',
        current_round = v_round,
        precountdown_started_at = now(),
        question_started_at = null,
        state_version = state_version + 1
    where id = v_game.id;
    v_event := 'PRECOUNTDOWN';

  elsif v_game.status = 'PRECOUNTDOWN' then
    select coalesce(q.time_limit, v_game.default_timer, 20) into v_timer
    from public.questions q
    where q.game_id = v_game.id and q.round = v_game.current_round
    limit 1;
    if v_timer is null then v_timer := coalesce(v_game.default_timer, 20); end if;

    delete from public.submissions where game_id = v_game.id and round = v_game.current_round;

    update public.games
    set status = 'QUESTION',
        question_timer_limit = v_timer,
        question_started_at = now(),
        precountdown_started_at = null,
        state_version = state_version + 1
    where id = v_game.id;
    v_event := 'QUESTION';

  elsif v_game.status = 'QUESTION' then
    return public.qa_reveal_round(v_game.game_pin, p_host_token, 'host_advance');

  elsif v_game.status = 'REVEAL' then
    update public.games
    set status = 'LEADERBOARD', state_version = state_version + 1
    where id = v_game.id;
    v_event := 'LEADERBOARD';

  elsif v_game.status = 'LEADERBOARD' then
    select q.round into v_next_round
    from public.questions q
    where q.game_id = v_game.id
      and q.sort_order > coalesce((select sort_order from public.questions where game_id = v_game.id and round = v_game.current_round limit 1), -1)
    order by q.sort_order asc, q.round asc
    limit 1;

    if v_next_round is null then
      update public.games
      set status = 'FINISHED', question_started_at = null, precountdown_started_at = null, state_version = state_version + 1
      where id = v_game.id;
      v_event := 'FINISHED';
    else
      update public.games
      set status = 'PRECOUNTDOWN', current_round = v_next_round, question_started_at = null, precountdown_started_at = now(), state_version = state_version + 1
      where id = v_game.id;
      v_event := 'PRECOUNTDOWN';
    end if;

  else
    v_event := v_game.status;
  end if;

  select * into v_game from public.games where id = v_game.id;
  perform public.qa_emit_event(v_game.id, v_event, v_game.current_round, jsonb_build_object('source', 'host'));

  return public.qa_host_snapshot(v_game.game_pin, p_host_token);
end;
$$;

create or replace function public.qa_reset_game(p_game_pin text, p_host_token text, p_keep_players boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_game public.games%rowtype;
  v_first_round text;
begin
  select * into v_game
  from public.games
  where game_pin = public.qa_clean_pin(p_game_pin)
  for update;

  if v_game.id is null then raise exception 'Game PIN not found.'; end if;
  if coalesce(p_host_token, '') <> v_game.host_token then raise exception 'Invalid host token.'; end if;

  select q.round into v_first_round
  from public.questions q
  where q.game_id = v_game.id
  order by q.sort_order asc, q.round asc
  limit 1;

  delete from public.submissions where game_id = v_game.id;
  delete from public.game_events where game_id = v_game.id;

  if coalesce(p_keep_players, false) then
    update public.players
    set total_score = 0, streak = 0, is_active = true, last_seen = now()
    where game_id = v_game.id;
  else
    delete from public.players where game_id = v_game.id;
  end if;

  update public.games
  set status = 'LOBBY',
      current_round = v_first_round,
      question_started_at = null,
      precountdown_started_at = null,
      question_timer_limit = default_timer,
      state_version = state_version + 1
  where id = v_game.id;

  perform public.qa_emit_event(v_game.id, 'RESET', v_first_round, jsonb_build_object('keepPlayers', coalesce(p_keep_players, false)));

  return public.qa_host_snapshot(v_game.game_pin, p_host_token);
end;
$$;

-- Useful for Apps Script sync checks.
create or replace function public.qa_backend_version()
returns jsonb
language sql
stable
as $$
  select jsonb_build_object('name', 'quiz-arena-supabase-runtime', 'version', '1.0.0', 'checkedAt', now())
$$;

-- Grant RPC access to browser anon key. The functions enforce validation internally.
grant execute on function public.qa_join_game(text, text, text) to anon;
grant execute on function public.qa_heartbeat(text, text) to anon;
grant execute on function public.qa_player_snapshot(text, text) to anon;
grant execute on function public.qa_host_snapshot(text, text) to anon;
grant execute on function public.qa_submit_answer(text, text, text, text) to anon;
grant execute on function public.qa_reveal_round(text, text, text) to anon;
grant execute on function public.qa_advance_game(text, text) to anon;
grant execute on function public.qa_reset_game(text, text, boolean) to anon;
grant execute on function public.qa_backend_version() to anon;
