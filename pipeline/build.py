"""Build the analytical DuckDB database from raw source files.

raw/*.csv.gz  ->  validate, clean, standardise  ->  data/juego.duckdb

Every table keeps the source's stable integer ids (player_id, club_id,
game_id) so later competitions can be added without re-keying.
"""

import datetime as dt
from pathlib import Path

import duckdb

from sources import COMPETITION_ID

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
DB = ROOT / "data" / "juego.duckdb"

# Display names and three-letter codes. The source names are already
# consistent across seasons; this only drops legal suffixes for the UI.
CLUB_SHORT = {
    989: ("Bournemouth", "BOU"), 11: ("Arsenal", "ARS"), 405: ("Aston Villa", "AVL"),
    1148: ("Brentford", "BRE"), 1237: ("Brighton", "BHA"), 1132: ("Burnley", "BUR"),
    603: ("Cardiff", "CAR"), 631: ("Chelsea", "CHE"), 873: ("Crystal Palace", "CRY"),
    29: ("Everton", "EVE"), 931: ("Fulham", "FUL"), 1110: ("Huddersfield", "HUD"),
    3008: ("Hull City", "HUL"), 677: ("Ipswich", "IPS"), 399: ("Leeds", "LEE"),
    1003: ("Leicester", "LEI"), 31: ("Liverpool", "LIV"), 1031: ("Luton", "LUT"),
    281: ("Man City", "MCI"), 985: ("Man United", "MUN"), 641: ("Middlesbrough", "MID"),
    762: ("Newcastle", "NEW"), 1123: ("Norwich", "NOR"), 703: ("Nott'm Forest", "NFO"),
    1039: ("QPR", "QPR"), 1032: ("Reading", "REA"), 350: ("Sheffield Utd", "SHU"),
    180: ("Southampton", "SOU"), 512: ("Stoke", "STK"), 289: ("Sunderland", "SUN"),
    2288: ("Swansea", "SWA"), 148: ("Tottenham", "TOT"), 1010: ("Watford", "WAT"),
    984: ("West Brom", "WBA"), 379: ("West Ham", "WHU"), 1071: ("Wigan", "WIG"),
    543: ("Wolves", "WOL"),
}


def raw(name: str) -> str:
    return f"read_csv_auto('{RAW / (name + '.csv.gz')}', header=true)"


def build() -> None:
    tmp = DB.with_suffix(".building")
    tmp.unlink(missing_ok=True)
    con = duckdb.connect(str(tmp))
    today = dt.date.today().isoformat()

    con.execute("create table club_names(club_id int, short_name varchar, code varchar)")
    con.executemany("insert into club_names values (?, ?, ?)",
                    [(k, v[0], v[1]) for k, v in CLUB_SHORT.items()])

    # ---- matches -----------------------------------------------------------
    con.execute(f"""
        create table matches as
        select
            game_id::bigint                         as match_id,
            competition_id,
            season::int                             as season,
            try_cast(regexp_extract(round, '(\\d+)', 1) as int) as matchday,
            date::date                              as date,
            home_club_id::int                       as home_id,
            away_club_id::int                       as away_id,
            home_club_goals::int                    as home_goals,
            away_club_goals::int                    as away_goals,
            case when home_club_goals > away_club_goals then 'H'
                 when home_club_goals < away_club_goals then 'A' else 'D' end as result,
            attendance::int                         as attendance,
            referee,
            home_club_manager_name                  as home_manager,
            away_club_manager_name                  as away_manager,
            home_club_formation                     as home_formation,
            away_club_formation                     as away_formation
        from {raw('games')}
        where competition_id = '{COMPETITION_ID}'
          and home_club_goals is not null and away_club_goals is not null
          and date::date <= '{today}'
        qualify row_number() over (partition by game_id order by date) = 1
    """)

    # ---- clubs (only those that have played in the competition) ------------
    con.execute(f"""
        create table clubs as
        with ids as (
            select home_id as club_id from matches union select away_id from matches
        )
        select ids.club_id,
               coalesce(n.short_name, c.name)       as name,
               coalesce(n.code, upper(left(c.name, 3))) as code,
               c.name                               as full_name,
               c.stadium_name                       as stadium,
               c.stadium_seats::int                 as stadium_seats,
               (select list(distinct season order by season) from matches m
                 where m.home_id = ids.club_id)     as seasons
        from ids
        left join {raw('clubs')} c on c.club_id = ids.club_id
        left join club_names n on n.club_id = ids.club_id
    """)

    # ---- appearances -------------------------------------------------------
    con.execute(f"""
        create table appearances as
        select a.game_id::bigint as match_id, a.player_id::int as player_id,
               a.player_club_id::int as club_id, m.season, m.date,
               a.minutes_played::int as minutes, a.goals::int as goals,
               a.assists::int as assists, a.yellow_cards::int as yellows,
               a.red_cards::int as reds,
               -- team context for the match, for clean sheets / points
               case when a.player_club_id = m.home_id then m.home_goals else m.away_goals end as team_goals,
               case when a.player_club_id = m.home_id then m.away_goals else m.home_goals end as opp_goals,
               a.player_club_id = m.home_id as is_home
        from {raw('appearances')} a
        join matches m on m.match_id = a.game_id
        where a.minutes_played between 0 and 130
        qualify row_number() over (partition by a.game_id, a.player_id order by a.minutes_played desc) = 1
    """)

    # ---- players (anyone who appeared in the competition) ------------------
    con.execute(f"""
        create table players as
        select p.player_id::int as player_id, p.name, p.first_name, p.last_name,
               try_cast(p.date_of_birth as date) as date_of_birth,
               nullif(p.position, 'Missing') as position,
               p.sub_position, p.foot, try_cast(p.height_in_cm as int) as height_cm,
               p.country_of_citizenship as nationality,
               p.current_club_id::int as current_club_id,
               p.current_club_name, p.current_club_domestic_competition_id as current_competition,
               try_cast(p.market_value_in_eur as bigint) as market_value_eur,
               try_cast(p.highest_market_value_in_eur as bigint) as highest_market_value_eur,
               try_cast(p.contract_expiration_date as date) as contract_expires,
               p.last_season::int as last_season
        from {raw('players')} p
        where p.player_id in (select distinct player_id from appearances)
    """)

    # ---- market valuations (recorded estimates, not fees) -----------------
    con.execute(f"""
        create table valuations as
        select distinct v.player_id::int as player_id, v.date::date as date,
               v.market_value_in_eur::bigint as value_eur,
               v.current_club_id::int as club_id, v.current_club_name as club_name,
               v.player_club_domestic_competition_id as competition_id
        from {raw('player_valuations')} v
        where v.player_id in (select player_id from players)
          and v.market_value_in_eur > 0 and v.date::date <= '{today}'
    """)

    # ---- transfers ---------------------------------------------------------
    # Fee semantics in the source: NULL = undisclosed/unknown, 0 = free or
    # loan. Future-dated rows are scheduled loan returns and are excluded.
    con.execute(f"""
        create table transfers as
        select t.player_id::int as player_id, t.player_name,
               t.transfer_date::date as date, t.transfer_season as season_label,
               t.from_club_id::int as from_club_id, t.from_club_name,
               t.to_club_id::int as to_club_id, t.to_club_name,
               t.transfer_fee::double as fee_eur,
               t.market_value_in_eur::double as value_at_transfer_eur,
               t.from_club_id::int in (select club_id from clubs) as from_league,
               t.to_club_id::int in (select club_id from clubs) as to_league
        from {raw('transfers')} t
        where t.player_id in (select player_id from players)
          and t.transfer_date::date <= '{today}'
    """)

    # ---- player-season aggregates -----------------------------------------
    con.execute("""
        create table player_seasons as
        with s as (
            select player_id, season,
                   arg_max(club_id, date) as club_id,
                   count(*) as apps,
                   sum((minutes >= 60)::int) as apps_60,
                   sum(minutes) as minutes, sum(goals) as goals, sum(assists) as assists,
                   sum(yellows) as yellows, sum(reds) as reds,
                   sum((minutes >= 89 and opp_goals = 0)::int) as clean_sheets_90,
                   sum(case when team_goals > opp_goals then 3 when team_goals = opp_goals then 1 else 0 end) as team_points
            from appearances group by all
        )
        select s.*, p.position, p.sub_position,
               date_diff('year', p.date_of_birth, make_date(s.season, 9, 1))
                 - (strftime(p.date_of_birth, '%m-%d') > '09-01')::int as age,
               goals + assists as ga,
               case when minutes > 0 then 90.0 * goals / minutes end as goals_p90,
               case when minutes > 0 then 90.0 * assists / minutes end as assists_p90,
               case when minutes > 0 then 90.0 * (goals + assists) / minutes end as ga_p90,
               team_points::double / apps as points_per_app
        from s join players p using (player_id)
    """)

    # ---- data-quality log --------------------------------------------------
    con.execute("create table data_quality(check_name varchar, status varchar, detail varchar)")
    checks = [
        ("Matches per season = 380",
         "select count(*) from (select season, count(*) n from matches group by 1 having n <> 380 and season < (select max(season) from matches))"),
        ("Every appearance links to a known match",
         f"select count(*) from {raw('appearances')} a where competition_id='{COMPETITION_ID}' and game_id not in (select match_id from matches)"),
        ("Every appearance links to a known player",
         "select count(*) from appearances where player_id not in (select player_id from players)"),
        ("No duplicate player-match rows",
         "select count(*) - count(distinct (match_id, player_id)) from appearances"),
        ("Players missing date of birth",
         "select count(*) from players where date_of_birth is null"),
        ("Players missing position",
         "select count(*) from players where position is null"),
        ("Goals in appearances match the scoreline (own goals excluded)",
         """select count(*) from (select m.match_id, m.home_goals + m.away_goals tg, coalesce(sum(a.goals),0) pg
            from matches m left join appearances a using (match_id) group by all having pg > tg)"""),
    ]
    for name, sql in checks:
        n = con.execute(sql).fetchall()[0][0]
        status = "pass" if n == 0 else ("info" if "missing" in name.lower() else "warn")
        con.execute("insert into data_quality values (?, ?, ?)", [name, status, f"{n} rows"])

    con.execute("""
        create table meta as
        select ? as competition_id, 'Premier League' as competition_name,
               (select min(season) from matches) as first_season,
               (select max(season) from matches) as last_season,
               (select max(date) from matches) as data_cutoff,
               current_timestamp as built_at
    """, [COMPETITION_ID])

    con.execute("checkpoint")
    con.close()
    tmp.replace(DB)

    con = duckdb.connect(str(DB), read_only=True)
    for t in ["clubs", "players", "matches", "appearances", "player_seasons", "valuations", "transfers"]:
        print(f"  {t:<15} {con.execute(f'select count(*) from {t}').fetchall()[0][0]:>8,}")
    print(con.sql("select * from data_quality"))


if __name__ == "__main__":
    build()
