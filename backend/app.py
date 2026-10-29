"""JUEGO local API.

Read-only over data/juego.duckdb. No accounts, no cookies, no analytics,
and request URLs (which can contain search terms) are not logged.
"""

import datetime as dt
import math
import pickle
import sys
import threading
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.gzip import GZipMiddleware

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "pipeline"))
from features import pair_features  # noqa: E402
from match_models import score_matrix  # noqa: E402

DB = ROOT / "data" / "juego.duckdb"
FRONTEND = ROOT / "frontend"

_con = duckdb.connect(str(DB), read_only=True)
_lock = threading.Lock()
with open(ROOT / "data" / "models" / "match.pkl", "rb") as f:
    MATCH = pickle.load(f)

app = FastAPI(title="JUEGO", docs_url="/api/docs", redoc_url=None, openapi_url="/api/openapi.json")
app.add_middleware(GZipMiddleware, minimum_size=1024)


@app.middleware("http")
async def privacy_headers(request: Request, call_next):
    resp = await call_next(request)
    resp.headers["Referrer-Policy"] = "no-referrer"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Permissions-Policy"] = "interest-cohort=(), browsing-topics=()"
    resp.headers["Content-Security-Policy"] = (
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; "
        "connect-src 'self'; frame-ancestors 'none'")
    if request.url.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "private, max-age=300"
    else:
        resp.headers["Cache-Control"] = "no-cache"  # revalidate so UI edits show up on reload
    return resp


def _clean(v):
    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
        return None
    if isinstance(v, (dt.date, dt.datetime)):
        return v.isoformat()
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.floating,)):
        return None if np.isnan(v) else float(v)
    if isinstance(v, list):
        return [_clean(x) for x in v]
    return v


def q(sql: str, params=None) -> list[dict]:
    with _lock:
        cur = _con.cursor()
        try:
            res = cur.execute(sql, params or [])
            cols = [d[0] for d in res.description]
            return [{c: _clean(v) for c, v in zip(cols, row)} for row in res.fetchall()]
        finally:
            cur.close()


def q1(sql: str, params=None):
    rows = q(sql, params)
    return rows[0] if rows else None


def latest_season() -> int:
    return META["last_season"]


META = q1("select * from meta")
# Transfer season labels are "yy/yy"; map to a sortable start year.
SEASON_START = "(case when left(season_label, 2)::int > 50 then 1900 else 2000 end + left(season_label, 2)::int)"


# ---------------------------------------------------------------- overview

@app.get("/api/meta")
def meta():
    counts = q1("""select (select count(*) from players) players, (select count(*) from clubs) clubs,
                          (select count(*) from matches) matches, (select count(*) from appearances) appearances,
                          (select count(*) from valuations) valuations, (select count(*) from transfers) transfers""")
    seasons = [r["season"] for r in q("select distinct season from matches order by 1 desc")]
    return {**META, "counts": counts, "seasons": seasons,
            "quality": q("select * from data_quality"),
            "unavailable": [
                "Expected goals (xG), shots and event-level data",
                "Starting line-ups vs substitute appearances",
                "Injuries and suspensions ahead of a fixture",
                "Defensive actions (tackles, interceptions, saves)",
                "Historical contract lengths",
            ]}


@app.get("/api/overview")
def overview(season: int | None = None):
    season = season or latest_season()
    table = league_table(season)
    scorers = q("""select s.player_id, p.name, c.code club, s.goals, s.assists, s.minutes, s.ga_p90
                   from player_seasons s join players p using (player_id) join clubs c using (club_id)
                   where season = ? order by goals desc, minutes asc limit 8""", [season])
    creators = q("""select s.player_id, p.name, c.code club, s.assists, s.goals, s.minutes
                    from player_seasons s join players p using (player_id) join clubs c using (club_id)
                    where season = ? order by assists desc, minutes asc limit 8""", [season])
    totals = q1("""select count(*) matches, sum(home_goals + away_goals) goals,
                          avg(home_goals + away_goals) goals_per_match,
                          avg((result = 'H')::int) home_win, avg((result = 'D')::int) draw,
                          avg((result = 'A')::int) away_win, avg(attendance) attendance
                   from matches where season = ?""", [season])
    trend = q("""select season, avg(home_goals + away_goals) goals_per_match,
                        avg((result = 'H')::int) home_win, avg((result = 'D')::int) draw,
                        avg((result = 'A')::int) away_win
                 from matches group by 1 order by 1""")
    return {"season": season, "table": table, "scorers": scorers, "creators": creators,
            "totals": totals, "trend": trend}


# ---------------------------------------------------------------- teams

def league_table(season: int) -> list[dict]:
    return q("""
        with r as (
            select home_id club_id, home_goals gf, away_goals ga, date from matches where season = $s
            union all select away_id, away_goals, home_goals, date from matches where season = $s)
        select club_id, c.name, c.code, count(*) played,
               sum((gf > ga)::int) won, sum((gf = ga)::int) drawn, sum((gf < ga)::int) lost,
               sum(gf) gf, sum(ga) ga, sum(gf) - sum(ga) gd,
               sum(case when gf > ga then 3 when gf = ga then 1 else 0 end) points,
               list(case when gf > ga then 'W' when gf = ga then 'D' else 'L' end order by date desc)[1:5] form
        from r join clubs c using (club_id)
        group by all order by points desc, gd desc, gf desc, name
    """, {"s": season})


@app.get("/api/teams")
def teams(season: int | None = None):
    season = season or latest_season()
    rows = league_table(season)
    for i, r in enumerate(rows):
        r["position"] = i + 1
    return {"season": season, "table": rows}


@app.get("/api/teams/{club_id}")
def team(club_id: int, season: int | None = None):
    club = q1("select * from clubs where club_id = ?", [club_id])
    if not club:
        raise HTTPException(404, "Unknown club")
    season = season or max(club["seasons"] or [latest_season()])
    results = q("""
        select m.match_id, m.date, m.matchday, m.home_id = $c as is_home,
               case when m.home_id = $c then a.name else h.name end opponent,
               case when m.home_id = $c then a.club_id else h.club_id end opponent_id,
               case when m.home_id = $c then m.home_goals else m.away_goals end gf,
               case when m.home_id = $c then m.away_goals else m.home_goals end ga,
               p.p_home, p.p_draw, p.p_away
        from matches m join clubs h on h.club_id = m.home_id join clubs a on a.club_id = m.away_id
        left join match_predictions p using (match_id)
        where season = $s and (home_id = $c or away_id = $c) order by date""", {"c": club_id, "s": season})
    squad = q("""select s.player_id, p.name, p.position, p.sub_position, s.age, s.apps, s.minutes,
                        s.goals, s.assists, s.ga_p90, s.clean_sheets_90
                 from player_seasons s join players p using (player_id)
                 where s.club_id = ? and s.season = ? order by s.minutes desc""", [club_id, season])
    history = q("""
        with r as (
            select season, home_id club_id, home_goals gf, away_goals ga from matches
            union all select season, away_id, away_goals, home_goals from matches),
        t as (select season, club_id, sum(case when gf > ga then 3 when gf = ga then 1 else 0 end) pts,
                     sum(gf) - sum(ga) gd, sum(gf) gf from r group by all)
        select season, pts, gd, rank() over (partition by season order by pts desc, gd desc, gf desc) position
        from t qualify club_id = ? order by season""", [club_id])
    state = q1("select * from team_state where club_id = ?", [club_id])
    return {"club": club, "season": season, "results": results, "squad": squad,
            "history": history, "state": state}


# ---------------------------------------------------------------- players

SORTABLE = {"name", "minutes", "apps", "goals", "assists", "ga", "ga_p90", "goals_p90",
            "assists_p90", "age", "market_value_eur", "clean_sheets_90"}


@app.get("/api/players")
def players(search: str = "", season: int | None = None, position: str = "",
            club_id: int | None = None, min_minutes: int = 0, sort: str = "ga",
            order: str = "desc", limit: int = Query(50, le=200), offset: int = 0):
    season = season or latest_season()
    sort = sort if sort in SORTABLE else "ga"
    order = "asc" if order == "asc" else "desc"
    where = ["s.season = $season", "s.minutes >= $min"]
    params = {"season": season, "min": min_minutes, "limit": limit, "offset": offset}
    if search:
        where.append("strip_accents(lower(p.name)) like '%' || strip_accents(lower($search)) || '%'")
        params["search"] = search.strip()[:60]
    if position:
        where.append("p.position = $pos")
        params["pos"] = position
    if club_id:
        where.append("s.club_id = $club")
        params["club"] = club_id
    w = " and ".join(where)
    base = f"""from player_seasons s join players p using (player_id) join clubs c on c.club_id = s.club_id
               where {w}"""
    count_params = {k: v for k, v in params.items() if k not in ("limit", "offset")}
    total = q1(f"select count(*) n {base}", count_params)["n"]
    rows = q(f"""select s.player_id, p.name, p.position, p.sub_position, p.nationality, s.age,
                        c.club_id, c.name club, c.code club_code, s.apps, s.minutes, s.goals,
                        s.assists, s.ga, s.goals_p90, s.assists_p90, s.ga_p90, s.clean_sheets_90,
                        p.market_value_eur
                 {base} order by {sort} {order} nulls last, s.minutes desc
                 limit $limit offset $offset""", params)
    return {"season": season, "total": total, "rows": rows}


@app.get("/api/players/{player_id}")
def player(player_id: int):
    p = q1("""select p.*, date_diff('year', date_of_birth, current_date)
                  - (strftime(date_of_birth, '%m-%d') > strftime(current_date, '%m-%d'))::int as age_now
              from players p where player_id = ?""", [player_id])
    if not p:
        raise HTTPException(404, "Unknown player")
    seasons = q("""select s.*, c.name club, c.code club_code from player_seasons s join clubs c using (club_id)
                   where player_id = ? order by season""", [player_id])
    values = q("select date, value_eur, club_name from valuations where player_id = ? order by date", [player_id])
    transfers = q("""select date, season_label, from_club_name, to_club_name, fee_eur, value_at_transfer_eur
                     from transfers where player_id = ? order by date desc""", [player_id])
    forecast = q1("select * from player_forecasts where player_id = ?", [player_id])
    vforecast = q1("select * from value_forecasts where player_id = ?", [player_id])
    pct = percentiles(player_id)
    recent = q("""select a.date, a.minutes, a.goals, a.assists, a.team_goals, a.opp_goals, a.is_home,
                         o.name opponent from appearances a join matches m using (match_id)
                  join clubs o on o.club_id = case when a.is_home then m.away_id else m.home_id end
                  where a.player_id = ? order by a.date desc limit 10""", [player_id])
    return {"player": p, "seasons": seasons, "valuations": values, "transfers": transfers,
            "forecast": forecast, "value_forecast": vforecast, "percentiles": pct, "recent": recent}


def percentiles(player_id: int, season: int | None = None):
    """Percentile ranks vs same sub-position, same season, ≥900 minutes."""
    row = q1("""select season, sub_position from player_seasons where player_id = ? and minutes >= 900
                order by season desc limit 1""", [player_id])
    if not row:
        return None
    rows = q("""
        with peers as (select * from player_seasons where season = $s and sub_position = $sp and minutes >= 900)
        select player_id, count(*) over () peers,
               percent_rank() over (order by goals_p90) as goals_p90,
               percent_rank() over (order by assists_p90) as assists_p90,
               percent_rank() over (order by ga_p90) as ga_p90,
               percent_rank() over (order by minutes) as "minutes",
               percent_rank() over (order by points_per_app) as points_per_app,
               percent_rank() over (order by clean_sheets_90::double / apps) as clean_sheet_rate
        from peers qualify player_id = $p""", {"s": row["season"], "sp": row["sub_position"], "p": player_id})
    return {**row, **rows[0]} if rows else None


@app.get("/api/compare")
def compare(ids: str, season: int | None = None):
    id_list = [int(x) for x in ids.split(",") if x.strip().isdigit()][:4]
    if not id_list:
        raise HTTPException(400, "Provide up to four player ids")
    out = []
    for pid in id_list:
        p = q1("select player_id, name, position, sub_position, nationality, market_value_eur from players where player_id = ?", [pid])
        if not p:
            continue
        s = q1(f"""select s.*, c.name club from player_seasons s join clubs c using (club_id)
                   where player_id = ? {'and season = ?' if season else ''}
                   order by season desc limit 1""", [pid, season] if season else [pid])
        career = q1("""select count(distinct season) seasons, sum(apps) apps, sum(minutes) "minutes",
                              sum(goals) goals, sum(assists) assists,
                              90.0 * sum(goals + assists) / nullif(sum(minutes), 0) ga_p90
                       from player_seasons where player_id = ?""", [pid])
        trend = q("select season, ga_p90, minutes from player_seasons where player_id = ? order by season", [pid])
        out.append({"player": p, "season": s, "career": career, "trend": trend,
                    "forecast": q1("select * from player_forecasts where player_id = ?", [pid])})
    return {"players": out}


@app.get("/api/search")
def search(q_: str = Query("", alias="q")):
    if len(q_.strip()) < 2:
        return {"players": [], "clubs": []}
    term = q_.strip()[:60]
    return {
        "players": q("""select player_id, name, position, last_season from players
                        where strip_accents(lower(name)) like '%' || strip_accents(lower(?)) || '%'
                        order by last_season desc, name limit 8""", [term]),
        "clubs": q("""select club_id, name, code from clubs
                      where lower(name) like '%' || lower(?) || '%' or lower(full_name) like '%' || lower(?) || '%'
                      limit 4""", [term, term]),
    }


# ---------------------------------------------------------------- matches & prediction

@app.get("/api/matches")
def matches(season: int | None = None, club_id: int | None = None, matchday: int | None = None):
    season = season or latest_season()
    where, params = ["season = $s"], {"s": season}
    if club_id:
        where.append("(home_id = $c or away_id = $c)"); params["c"] = club_id
    if matchday:
        where.append("matchday = $md"); params["md"] = matchday
    return {"season": season, "rows": q(f"""
        select m.match_id, m.date, m.matchday, m.home_id, h.name home, h.code home_code,
               m.away_id, a.name away, a.code away_code, m.home_goals, m.away_goals, m.result,
               p.p_home, p.p_draw, p.p_away, p.exp_home_goals, p.exp_away_goals
        from matches m join clubs h on h.club_id = m.home_id join clubs a on a.club_id = m.away_id
        left join match_predictions p using (match_id)
        where {' and '.join(where)} order by m.date, m.match_id""", params)}


@app.get("/api/predict")
def predict(home: int, away: int):
    if home == away:
        raise HTTPException(400, "Choose two different clubs")
    st = MATCH["states"]
    if home not in st or away not in st:
        raise HTTPException(404, "No rating history for one of these clubs")
    feats = pd.DataFrame([pair_features(st[home], st[away])])
    p = MATCH["outcome"].predict_proba(feats)[0]
    lh, la = MATCH["poisson"].rates(feats)
    grid = score_matrix(float(lh[0]), float(la[0]))[:6, :6]
    scores = sorted(((float(grid[i, j]), i, j) for i in range(6) for j in range(6)), reverse=True)[:6]
    h2h = q("""select date, season, home_id, away_id, home_goals, away_goals from matches
               where (home_id = $h and away_id = $a) or (home_id = $a and away_id = $h)
               order by date desc limit 10""", {"h": home, "a": away})
    clubs = {r["club_id"]: r for r in q("select club_id, name, code from clubs where club_id in (?, ?)", [home, away])}
    return {
        "as_of": MATCH["as_of"], "model": MATCH["outcome_name"], "version": MATCH["version"],
        "home": {**clubs[home], **{k: float(v) for k, v in st[home].items()}},
        "away": {**clubs[away], **{k: float(v) for k, v in st[away].items()}},
        "p_home": float(p[0]), "p_draw": float(p[1]), "p_away": float(p[2]),
        "exp_home_goals": float(lh[0]), "exp_away_goals": float(la[0]),
        "grid": grid.round(5).tolist(),
        "likely_scores": [{"home": i, "away": j, "p": pr} for pr, i, j in scores],
        "p_btts": float(1 - grid[0, :].sum() - grid[:, 0].sum() + grid[0, 0]),
        "p_over_2_5": float(1 - sum(grid[i, j] for i in range(6) for j in range(6) if i + j <= 2)),
        "head_to_head": h2h,
    }


# ---------------------------------------------------------------- scouting & transfers

@app.get("/api/scouting")
def scouting(season: int | None = None, position: str = "Attack", sub_position: str = "",
             max_age: int = 40, min_minutes: int = 900, limit: int = Query(40, le=100)):
    season = season or latest_season()
    params = {"s": season, "pos": position, "age": max_age, "min": min_minutes, "limit": limit}
    sp = ""
    if sub_position:
        sp = "and sub_position = $sp"; params["sp"] = sub_position
    rows = q(f"""
        with pool as (
            select s.*, p.name, p.nationality, p.market_value_eur, c.code club_code, c.name club,
                   clean_sheets_90::double / apps cs_rate
            from player_seasons s join players p using (player_id) join clubs c on c.club_id = s.club_id
            where s.season = $s and s.position = $pos and s.minutes >= $min {sp}),
        ranked as (
            select *, percent_rank() over (order by ga_p90) pr_ga,
                      percent_rank() over (order by goals_p90) pr_g,
                      percent_rank() over (order by assists_p90) pr_a,
                      percent_rank() over (order by points_per_app) pr_ppa,
                      percent_rank() over (order by cs_rate) pr_cs,
                      percent_rank() over (order by minutes) pr_min
            from pool)
        select r.*, f.pred_ga_p90, f.pred_lo, f.pred_hi, v.pred_value_eur,
               -- Composite: output-led for attackers/midfielders; defenders and
               -- keepers lean on team outcomes because tackles/saves aren't in the data.
               case when $pos in ('Attack', 'Midfield')
                    then 0.45 * pr_ga + 0.2 * pr_g + 0.15 * pr_a + 0.1 * pr_ppa + 0.1 * pr_min
                    else 0.4 * pr_cs + 0.3 * pr_ppa + 0.2 * pr_min + 0.1 * pr_ga end as score
        from ranked r
        left join player_forecasts f using (player_id)
        left join value_forecasts v using (player_id)
        where r.age <= $age
        order by score desc limit $limit""", params)
    return {"season": season, "position": position, "rows": rows}


@app.get("/api/transfers")
def transfers(season_label: str = ""):
    labels = [r["season_label"] for r in q(f"""select season_label from transfers
                                              where season_label ~ '^\\d\\d/\\d\\d$'
                                              group by 1 order by {SEASON_START} desc limit 14""")]
    # The newest window may still be open at the data cutoff; default to the
    # latest complete-looking one and flag the partial window instead.
    deals = {r["season_label"]: r["n"] for r in q("""select season_label, count(*) filter (where fee_eur > 0 and to_league) n
                                                     from transfers group by 1""")}
    partial = labels[0] if len(labels) > 1 and deals.get(labels[0], 0) < 0.3 * deals.get(labels[1], 1) else None
    season_label = season_label or (labels[1] if partial else labels[0])
    top = q("""select player_id, player_name, date, from_club_name, to_club_name, fee_eur,
                      value_at_transfer_eur, to_league, from_league
               from transfers where season_label = ? and fee_eur > 0 and (to_league or from_league)
               order by fee_eur desc limit 25""", [season_label])
    clubs = q("""
        with t as (select * from transfers where season_label = $l and fee_eur is not null)
        select c.club_id, c.name, c.code,
               coalesce(sum(fee_eur) filter (where to_club_id = c.club_id), 0) spent,
               coalesce(sum(fee_eur) filter (where from_club_id = c.club_id), 0) received,
               count(*) filter (where to_club_id = c.club_id and fee_eur > 0) signings
        from clubs c join t on c.club_id in (t.to_club_id, t.from_club_id)
        group by all having spent + received > 0 order by spent - received desc""", {"l": season_label})
    trend = q(f"""select season_label, sum(fee_eur) filter (where to_league) spend,
                        count(*) filter (where to_league and fee_eur > 0) deals,
                        sum((fee_eur is null)::int) filter (where to_league) undisclosed
                 from transfers where season_label ~ '^\\d\\d/\\d\\d$'
                 group by 1 order by {SEASON_START} desc limit 14""")
    return {"season_label": season_label, "labels": labels, "partial": partial, "top": top, "clubs": clubs,
            "trend": list(reversed(trend))}


@app.get("/api/valuations/movers")
def value_movers(limit: int = 12, min_value: int = 5_000_000):
    rows = q("""select f.*, p.name, p.position, c.code club_code,
                       date_diff('year', p.date_of_birth, current_date) age,
                       pred_value_eur / value_eur - 1 change
                from value_forecasts f join players p using (player_id)
                left join clubs c on c.club_id = p.current_club_id
                where value_eur >= ? order by change desc""", [min_value])
    return {"rising": rows[:limit], "falling": rows[::-1][:limit],
            "top_valued": sorted(rows, key=lambda r: -r["value_eur"])[:limit]}


# ---------------------------------------------------------------- models

@app.get("/api/models")
def models():
    return {"registry": q("select * from model_registry"),
            "runs": q("select * from model_runs"),
            "calibration": q("select * from calibration order by outcome, bin_lo")}


# ---------------------------------------------------------------- frontend

@app.exception_handler(Exception)
async def unhandled(_: Request, exc: Exception):
    return JSONResponse({"detail": "Internal error"}, status_code=500)


app.mount("/static", StaticFiles(directory=FRONTEND), name="static")


@app.get("/")
def index():
    return FileResponse(FRONTEND / "index.html")
