-- =====================================================================
--  GO BATTLE LIVE — Supabase Schema  v1.0
--  วางทั้งไฟล์นี้ใน Supabase → SQL Editor → Run
--  ปลอดภัยต่อการรันซ้ำ (ใช้ if not exists / or replace ทุกจุด)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. ENUM
-- ---------------------------------------------------------------------
do $$ begin
  create type user_role   as enum ('player','teacher','director','admin');
exception when duplicate_object then null; end $$;

do $$ begin
  create type game_result as enum ('black_win','white_win','draw','no_result','unfinished');
exception when duplicate_object then null; end $$;

do $$ begin
  create type ai_engine   as enum ('light_wasm','katago_human');
exception when duplicate_object then null; end $$;


-- ---------------------------------------------------------------------
-- 1. โปรไฟล์สมาชิก  (ผูกกับ auth.users ของ Supabase Auth)
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id                        uuid primary key references auth.users(id) on delete cascade,
  display_name              text not null check (char_length(display_name) between 2 and 24),
  avatar_id                 text default 'default',
  birth_year                int  check (birth_year between 1920 and extract(year from now())::int),
  school                    text,
  role                      user_role not null default 'player',

  -- ดั้งจริงที่สมาคมฯ รับรอง — ต้องให้บัญชี teacher เป็นคนใส่เท่านั้น
  official_rank             text,
  official_rank_verified_by uuid references public.profiles(id),
  official_rank_verified_at timestamptz,

  -- อีเมลผู้ปกครอง (บังคับกรอกถ้าอายุต่ำกว่า 13)
  guardian_email            text,

  created_at                timestamptz not null default now(),
  last_seen_at              timestamptz
);

comment on column public.profiles.official_rank is
  'ดั้งที่สมาคมกีฬาหมากล้อมแห่งประเทศไทยรับรอง — คนละอย่างกับดั้งในระบบ (ตาราง ratings)';

-- สร้างโปรไฟล์อัตโนมัติเมื่อสมัครสมาชิกใหม่
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email,'@',1))
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ---------------------------------------------------------------------
-- 2. ระบบดั้ง — เก็บเป็น GoR แยกตามขนาดกระดาน
--    GoR 2100 = 1 ดั้ง / ห่างกัน 100 แต้ม = 1 ระดับ = แต้มต่อ 1 เม็ด
-- ---------------------------------------------------------------------
create table if not exists public.ratings (
  user_id        uuid not null references public.profiles(id) on delete cascade,
  board_size     smallint not null check (board_size in (9,13,19)),
  gor            double precision not null default 100,   -- เริ่มต้น 20 คิว
  deviation      double precision not null default 200,
  games_played   int not null default 0,
  is_provisional boolean not null default true,           -- จริงจนกว่าจะครบ 10 เกม
  peak_gor       double precision not null default 100,
  updated_at     timestamptz not null default now(),
  primary key (user_id, board_size)
);

-- แปลง GoR -> ป้ายคิว/ดั้งภาษาไทย
create or replace function public.gor_to_rank_label(gor double precision)
returns text language plpgsql immutable as $$
declare v int;
begin
  if gor is null then return '—'; end if;
  if gor >= 2100 then
    v := floor((gor - 2000) / 100);
    if v > 9 then v := 9; end if;
    return v || ' ดั้ง';
  else
    v := ceil((2100 - gor) / 100);
    if v < 1  then v := 1;  end if;
    if v > 30 then v := 30; end if;
    return v || ' คิว';
  end if;
end $$;

-- แปลงป้ายคิว/ดั้ง -> GoR (ใช้ตอนสมาชิกใหม่ประเมินตัวเอง)
create or replace function public.rank_label_to_gor(label text)
returns double precision language plpgsql immutable as $$
declare n int;
begin
  n := (regexp_match(label, '(\d+)'))[1]::int;
  if label like '%ดั้ง%' or lower(label) like '%d%' then
    return 2000 + n * 100;
  else
    return 2100 - n * 100;
  end if;
end $$;

-- แต้มต่อที่ควรใช้เมื่อสองคนนี้เจอกัน (1 ระดับ = 1 เม็ด, สูงสุด 9)
create or replace function public.suggested_handicap(gor_a double precision, gor_b double precision)
returns int language sql immutable as $$
  select least(9, greatest(0, round(abs(gor_a - gor_b) / 100)::int));
$$;


-- ---------------------------------------------------------------------
-- 3. คู่ต่อสู้ AI
-- ---------------------------------------------------------------------
create table if not exists public.ai_opponents (
  id             text primary key,
  name_th        text not null,
  rank_label     text not null,
  gor            double precision not null,
  engine         ai_engine not null,
  profile_string text,                    -- humanSLProfile ของ KataGo เช่น 'rank_5k'
  avatar_id      text,
  portrait_url   text,
  tagline_th     text,
  sort_order     int not null default 0,
  enabled        boolean not null default true
);

insert into public.ai_opponents
  (id, name_th, rank_label, gor, engine, profile_string, tagline_th, sort_order) values
  ('seed15k',  'น้องเมล็ด',    '15 คิว', 600,  'light_wasm',    null,        'เพิ่งหัดเล่น ใจดี ไม่กัด',           10),
  ('bamboo10k','พี่ไผ่',       '10 คิว', 1100, 'light_wasm',    null,        'ชอบต่อหมากเป็นแถวยาว ๆ',            20),
  ('ping8k',   'พี่ครูปิง',     '8 คิว',  1300, 'katago_human',  'rank_8k',   'สอนไปด่าไป แต่หวังดี',              30),
  ('stone2k',  'อาจารย์หิน',   '2 คิว',  1900, 'katago_human',  'rank_2k',   'นิ่ง ๆ แต่ล้อมพื้นที่เก่งมาก',       40),
  ('leaf3d',   'เซียนใบไผ่',   '3 ดั้ง',  2300, 'katago_human',  'rank_3d',   'สไตล์บุก ชอบเปิดศึกกลางกระดาน',      50),
  ('shadow7d', 'เงาไร้ชื่อ',    '7 ดั้ง',  2700, 'katago_human',  'rank_7d',   'ไม่มีใครรู้ว่าเป็นใคร',              60)
on conflict (id) do nothing;


-- ---------------------------------------------------------------------
-- 4. เกม / ตาเดิน / ไฮไลต์
-- ---------------------------------------------------------------------
create table if not exists public.games (
  id             uuid primary key default gen_random_uuid(),
  room_code      text not null,
  black_id       uuid references public.profiles(id) on delete set null,
  white_id       uuid references public.profiles(id) on delete set null,
  is_ai_game     boolean not null default false,
  ai_opponent_id text references public.ai_opponents(id),
  ai_plays_color char(1) check (ai_plays_color in ('B','W')),

  board_size     smallint not null check (board_size in (9,13,19)),
  komi           numeric(4,1) not null,
  handicap       smallint not null default 0 check (handicap between 0 and 9),
  time_rule      jsonb not null,          -- {"main":300,"byoyomi":30,"periods":3}

  result         game_result not null default 'unfinished',
  result_text    text,                    -- เช่น 'B+7.5', 'W+R', 'Draw', 'No result (สามโคะ)'
  score_black    numeric(5,1),
  score_white    numeric(5,1),

  sgf            text,
  rated          boolean not null default true,
  started_at     timestamptz not null default now(),
  ended_at       timestamptz
);

create index if not exists games_black_idx on public.games(black_id, started_at desc);
create index if not exists games_white_idx on public.games(white_id, started_at desc);
create index if not exists games_room_idx  on public.games(room_code, started_at desc);

create table if not exists public.moves (
  game_id      uuid not null references public.games(id) on delete cascade,
  seq          int  not null,
  color        char(1) not null check (color in ('B','W')),
  x            smallint,                  -- null = ผ่าน
  y            smallint,
  is_pass      boolean not null default false,
  time_left_ms int,
  played_at    timestamptz not null default now(),
  primary key (game_id, seq)
);

create table if not exists public.highlights (
  id         bigserial primary key,
  game_id    uuid not null references public.games(id) on delete cascade,
  seq        int  not null,
  pattern_id text not null,
  tier       char(3) not null check (tier in ('R','SR','SSR')),
  coords     jsonb,
  color      char(1),
  created_at timestamptz not null default now()
);

create index if not exists highlights_pattern_idx on public.highlights(pattern_id);


-- ---------------------------------------------------------------------
-- 5. ประวัติการขึ้น-ลงดั้ง
-- ---------------------------------------------------------------------
create table if not exists public.rating_history (
  id         bigserial primary key,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  game_id    uuid references public.games(id) on delete set null,
  board_size smallint not null,
  gor_before double precision not null,
  gor_after  double precision not null,
  delta      double precision generated always as (gor_after - gor_before) stored,
  created_at timestamptz not null default now()
);

create index if not exists rating_history_user_idx
  on public.rating_history(user_id, board_size, created_at desc);


-- ---------------------------------------------------------------------
-- 6. รอบการถ่ายทอดสด
-- ---------------------------------------------------------------------
create table if not exists public.live_sessions (
  id           bigserial primary key,
  room_code    text not null,
  game_id      uuid references public.games(id) on delete set null,
  went_live_at timestamptz not null default now(),
  off_air_at   timestamptz,
  director_id  uuid references public.profiles(id) on delete set null,
  peak_viewers int
);


-- ---------------------------------------------------------------------
-- 7. ตารางอันดับ (view) — ตัดผู้ที่ยังอยู่ในช่วงทดลองออก
-- ---------------------------------------------------------------------
create or replace view public.leaderboard as
select
  r.board_size,
  r.user_id,
  p.display_name,
  p.avatar_id,
  r.gor,
  public.gor_to_rank_label(r.gor) as rank_label,
  r.games_played,
  r.peak_gor,
  rank() over (partition by r.board_size order by r.gor desc) as position
from public.ratings r
join public.profiles p on p.id = r.user_id
where r.is_provisional = false
  and r.games_played >= 10;


-- =====================================================================
-- 8. ROW LEVEL SECURITY
--    หลักการ: เบราว์เซอร์ "อ่านได้ แต่เขียนคะแนนไม่ได้"
--    การเขียนผลเกมและดั้งทั้งหมดทำโดยเซิร์ฟเวอร์เกมด้วย service_role
--    (service_role ข้าม RLS อัตโนมัติ จึงไม่ต้องเขียน policy ให้)
-- =====================================================================
alter table public.profiles       enable row level security;
alter table public.ratings        enable row level security;
alter table public.games          enable row level security;
alter table public.moves          enable row level security;
alter table public.highlights     enable row level security;
alter table public.rating_history enable row level security;
alter table public.ai_opponents   enable row level security;
alter table public.live_sessions  enable row level security;

-- profiles: ใครก็อ่านได้ (ต้องโชว์ชื่อคู่แข่ง) แต่แก้ได้เฉพาะของตัวเอง
drop policy if exists profiles_read      on public.profiles;
drop policy if exists profiles_update_own on public.profiles;

create policy profiles_read on public.profiles
  for select using (true);

create policy profiles_update_own on public.profiles
  for update using (auth.uid() = id)
  with check (
    auth.uid() = id
    -- กันผู้เล่นแก้ role หรือปั้มดั้งสมาคมฯ ให้ตัวเอง
    and role = (select role from public.profiles where id = auth.uid())
    and official_rank is not distinct from
        (select official_rank from public.profiles where id = auth.uid())
  );

-- ratings / rating_history / games / moves / highlights: อ่านอย่างเดียว
drop policy if exists ratings_read        on public.ratings;
drop policy if exists rating_history_read on public.rating_history;
drop policy if exists games_read          on public.games;
drop policy if exists moves_read          on public.moves;
drop policy if exists highlights_read     on public.highlights;
drop policy if exists ai_read             on public.ai_opponents;
drop policy if exists live_read           on public.live_sessions;

create policy ratings_read        on public.ratings        for select using (true);
create policy rating_history_read on public.rating_history for select using (auth.uid() = user_id);
create policy games_read          on public.games          for select using (true);
create policy moves_read          on public.moves          for select using (true);
create policy highlights_read     on public.highlights     for select using (true);
create policy ai_read             on public.ai_opponents   for select using (enabled);
create policy live_read           on public.live_sessions  for select using (true);


-- =====================================================================
-- 9. ฟังก์ชันปรับดั้งหลังจบเกม  (เรียกจากเซิร์ฟเวอร์เกมด้วย service_role)
--    ใช้สูตร EGF GoR แบบย่อ: ยิ่งเก่ง ค่า K ยิ่งเล็ก ดั้งยิ่งนิ่ง
-- =====================================================================
create or replace function public.gor_con(gor double precision)
returns double precision language sql immutable as $$
  -- ค่าความผันผวนตามระดับ: 20 คิว ขยับเร็ว, ระดับดั้ง ขยับช้า
  select greatest(10, 116 - 0.045 * greatest(gor, 100));
$$;

create or replace function public.apply_game_rating(
  p_game_id     uuid,
  p_board_size  smallint,
  p_black_id    uuid,
  p_white_id    uuid,
  p_black_won   boolean,
  p_weight      double precision default 1.0   -- เกมกับ AI ส่ง 0.5
) returns void language plpgsql security definer set search_path = public as $$
declare
  gb double precision; gw double precision;
  eb double precision; kb double precision; kw double precision;
  nb double precision; nw double precision;
begin
  if p_black_id is null or p_white_id is null then return; end if;

  select gor into gb from ratings where user_id = p_black_id and board_size = p_board_size;
  select gor into gw from ratings where user_id = p_white_id and board_size = p_board_size;
  if gb is null or gw is null then return; end if;

  -- โอกาสชนะของดำ (logistic บนส่วนต่าง GoR)
  eb := 1.0 / (1.0 + exp((gw - gb) / 104.0));
  kb := gor_con(gb) * p_weight;
  kw := gor_con(gw) * p_weight;

  nb := gb + kb * ((case when p_black_won then 1 else 0 end) - eb);
  nw := gw + kw * ((case when p_black_won then 0 else 1 end) - (1 - eb));

  nb := greatest(nb, 50);
  nw := greatest(nw, 50);

  insert into rating_history (user_id, game_id, board_size, gor_before, gor_after)
  values (p_black_id, p_game_id, p_board_size, gb, nb),
         (p_white_id, p_game_id, p_board_size, gw, nw);

  update ratings set
    gor            = nb,
    games_played   = games_played + 1,
    is_provisional = (games_played + 1) < 10,
    peak_gor       = greatest(peak_gor, nb),
    deviation      = greatest(30, deviation * 0.92),
    updated_at     = now()
  where user_id = p_black_id and board_size = p_board_size;

  update ratings set
    gor            = nw,
    games_played   = games_played + 1,
    is_provisional = (games_played + 1) < 10,
    peak_gor       = greatest(peak_gor, nw),
    deviation      = greatest(30, deviation * 0.92),
    updated_at     = now()
  where user_id = p_white_id and board_size = p_board_size;
end $$;


-- =====================================================================
-- 10. กันโกง — ตรวจว่าเกมนี้ควรคิดดั้งไหม
--     คู่เดิมเจอกันเกิน 3 เกมใน 24 ชม. -> เกมที่เกินไม่คิดคะแนน
-- =====================================================================
create or replace function public.should_rate_game(
  p_a uuid, p_b uuid, p_board_size smallint
) returns boolean language sql stable as $$
  select count(*) < 3
  from public.games g
  where g.rated = true
    and g.board_size = p_board_size
    and g.started_at > now() - interval '24 hours'
    and (
      (g.black_id = p_a and g.white_id = p_b) or
      (g.black_id = p_b and g.white_id = p_a)
    );
$$;

-- =====================================================================
--  จบ schema
-- =====================================================================
