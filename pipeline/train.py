"""Train and evaluate JUEGO's models with strictly chronological splits.

For each task:
  1. fit simple baselines and candidate models on the training seasons,
  2. choose a candidate on the validation seasons,
  3. refit on train+validation and score once on the held-out test seasons,
  4. refit on everything available and write forecasts.

All metrics, splits and feature lists are written to the database so the
dashboard can show exactly how each model was evaluated.
"""

import datetime as dt
import json
import pickle
import warnings
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.linear_model import Ridge
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from features import (AWAY_GOAL_FEATURES, HOME_GOAL_FEATURES, OUTCOME_FEATURES,
                      build_match_features)
from match_models import CLASSES, FrequencyModel, LogitModel, PoissonModel

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "data" / "juego.duckdb"
MODELS = ROOT / "data" / "models"
VERSION = dt.date.today().strftime("%Y.%m.%d")
SEED = 7
warnings.filterwarnings("ignore", message="divide by zero")


runs: list[dict] = []


def season_label(s) -> str:
    s = int(s)
    return f"{s}/{str(s + 1)[-2:]}"

registry: list[dict] = []


def record(task, model, role, split, **metrics):
    for k, v in metrics.items():
        runs.append({"task": task, "model": model, "role": role, "split": split,
                     "metric": k, "value": float(v)})


# =========================================================================
# Match outcomes
# =========================================================================

def outcome_metrics(p: np.ndarray, y) -> dict:
    y = np.asarray(y, dtype=object)
    onehot = (y[:, None] == CLASSES[None, :]).astype(float)
    p = np.clip(p, 1e-12, 1)
    cum_p, cum_y = np.cumsum(p, 1)[:, :2], np.cumsum(onehot, 1)[:, :2]
    return {
        "log_loss": float(-np.mean(np.log((p * onehot).sum(1)))),
        "brier": float(np.mean(((p - onehot) ** 2).sum(1))),
        "rps": float(np.mean(((cum_p - cum_y) ** 2).sum(1) / 2)),
        "accuracy": float(np.mean(CLASSES[p.argmax(1)] == y)),
        "n": len(y),
    }


def train_matches(con):
    matches = con.sql("select * from matches order by date, match_id").df()
    feats, teams = build_match_features(matches)
    feats = feats[feats.season > feats.season.min()]   # first season is Elo warm-up

    last = int(feats.season.max())
    test_seasons = [last - 1, last]
    val_seasons = [last - 3, last - 2]
    tr = feats[feats.season < val_seasons[0]]
    va = feats[feats.season.isin(val_seasons)]
    trva = feats[feats.season < test_seasons[0]]
    te = feats[feats.season.isin(test_seasons)]

    candidates = {
        "Home/draw/away frequencies": (lambda: FrequencyModel(), "baseline"),
        "Elo logistic": (lambda: LogitModel(["elo_diff"]), "candidate"),
        "Multinomial logistic (Elo + form + strength)": (lambda: LogitModel(OUTCOME_FEATURES, C=0.5), "candidate"),
        "Poisson goals model": (lambda: PoissonModel(), "candidate"),
    }
    val_scores = {}
    for name, (make, role) in candidates.items():
        m = make().fit(tr, tr.result.values)
        met = outcome_metrics(m.predict_proba(va), va.result.values)
        record("match_outcome", name, role, "validation", **met)
        if role == "candidate":
            val_scores[name] = met["log_loss"]
    chosen = min(val_scores, key=val_scores.get)
    MODEL_FEATURES = {"Elo logistic": ["elo_diff"],
                      "Multinomial logistic (Elo + form + strength)": OUTCOME_FEATURES,
                      "Poisson goals model": sorted(set(HOME_GOAL_FEATURES + AWAY_GOAL_FEATURES))}

    test_preds = {}
    for name, (make, role) in candidates.items():
        m = make().fit(trva, trva.result.values)
        p = m.predict_proba(te)
        test_preds[name] = p
        record("match_outcome", name, "selected" if name == chosen else role, "test",
               **outcome_metrics(p, te.result.values))

    # Calibration of the chosen model on the test seasons (one-vs-rest).
    p, y = test_preds[chosen], np.asarray(te.result, dtype=object)
    calib = []
    edges = np.linspace(0, 1, 11)
    for i, c in enumerate(CLASSES):
        for lo, hi in zip(edges[:-1], edges[1:]):
            mask = (p[:, i] >= lo) & (p[:, i] < hi)
            if mask.sum() >= 8:
                calib.append({"outcome": c, "bin_lo": lo, "bin_hi": hi, "n": int(mask.sum()),
                              "predicted": float(p[mask, i].mean()),
                              "observed": float((y[mask] == c).mean())})

    # Out-of-sample pre-match probabilities for the test seasons, plus the
    # Poisson model's expected goals for each fixture.
    pois = PoissonModel().fit(trva)
    lh, la = pois.rates(te)
    oos = te[["match_id"]].copy()
    oos["p_home"], oos["p_draw"], oos["p_away"] = p[:, 0], p[:, 1], p[:, 2]
    oos["exp_home_goals"], oos["exp_away_goals"] = lh, la
    oos["model_version"] = VERSION

    # Final fit on everything for live predictions.
    final_outcome = candidates[chosen][0]().fit(feats, feats.result.values)
    final_pois = PoissonModel().fit(feats)
    states = {cid: t.snapshot() for cid, t in teams.items()}
    as_of = str(matches.date.max())
    with open(MODELS / "match.pkl", "wb") as f:
        pickle.dump({"outcome": final_outcome, "outcome_name": chosen, "poisson": final_pois,
                     "states": states, "as_of": as_of, "version": VERSION}, f)

    team_state = pd.DataFrame([{"club_id": k, **v} for k, v in states.items()])
    team_state["as_of"] = as_of

    registry.append({
        "task": "match_outcome", "selected_model": chosen, "version": VERSION,
        "target": "Full-time result (home win / draw / away win)",
        "features": json.dumps(MODEL_FEATURES[chosen]),
        "train": f"{season_label(tr.season.min())} – {season_label(tr.season.max())}",
        "validation": ", ".join(map(season_label, val_seasons)),
        "test": ", ".join(map(season_label, test_seasons)),
        "selection_metric": "log_loss (validation)",
        "notes": "Pre-match features use only earlier matches. Elo warm-up season excluded. "
                 "Lineups, injuries, xG and odds are not in the source data and are not modelled.",
    })
    return team_state, oos, pd.DataFrame(calib)


# =========================================================================
# Player goal contributions per 90 (next season)
# =========================================================================

PLAYER_FEATURES = ["ga_p90", "goals_p90", "assists_p90", "prev_ga_p90", "has_prev",
                   "career_ga_p90", "minutes", "apps", "age", "points_per_app",
                   "pos_Attack", "pos_Midfield", "pos_Defender", "pos_Goalkeeper"]
MIN_MINUTES = 900


def player_frame(con) -> pd.DataFrame:
    ps = con.sql("select * from player_seasons where position is not null").df()
    ps = ps.sort_values(["player_id", "season"])
    g = ps.groupby("player_id")
    ps["prev_ga_p90"] = g.ga_p90.shift(1)
    ps["prev_min"] = g.minutes.shift(1)
    ps.loc[ps.prev_min < 450, "prev_ga_p90"] = np.nan
    ps["has_prev"] = ps.prev_ga_p90.notna().astype(int)
    ps["cum_ga"], ps["cum_min"] = g.ga.cumsum(), g.minutes.cumsum()
    ps["career_ga_p90"] = 90 * ps.cum_ga / ps.cum_min.clip(lower=1)
    for pos in ["Attack", "Midfield", "Defender", "Goalkeeper"]:
        ps[f"pos_{pos}"] = (ps.position == pos).astype(int)
    pos_mean = ps[ps.minutes >= MIN_MINUTES].groupby("position").ga_p90.mean()
    ps["prev_ga_p90"] = ps.prev_ga_p90.fillna(ps.position.map(pos_mean))
    ps["age"] = ps.age.fillna(ps.age.median())
    nxt = ps[["player_id", "season", "ga_p90", "minutes"]].copy()
    nxt["season"] -= 1
    return ps.merge(nxt.rename(columns={"ga_p90": "target", "minutes": "target_minutes"}),
                    on=["player_id", "season"], how="left")


def wmae(y, p, w):
    return float(np.sum(w * np.abs(y - p)) / np.sum(w))


def shrink_baseline(df, prior):
    # Empirical-Bayes style: blend own rate with the position mean, weighted
    # by minutes; 900 prior minutes is roughly ten full matches.
    m0 = 900
    return (df.ga_p90 * df.minutes + df.position.map(prior) * m0) / (df.minutes + m0)


def train_players(con):
    ps = player_frame(con)
    labelled = ps[(ps.minutes >= MIN_MINUTES) & (ps.target_minutes >= MIN_MINUTES)]
    last_target = int(labelled.season.max()) + 1
    test_t = [last_target - 1, last_target]
    val_t = [last_target - 2]
    tgt = labelled.season + 1
    tr, va = labelled[tgt < val_t[0]], labelled[tgt.isin(val_t)]
    trva, te = labelled[tgt < test_t[0]], labelled[tgt.isin(test_t)]

    def baselines(train, df):
        prior = train.groupby("position").target.mean()
        return {"Last season per 90 (persistence)": df.ga_p90.values,
                "Position average": df.position.map(prior).values,
                "Shrunk toward position average": shrink_baseline(df, prior).values}

    cands = {
        "Ridge regression": lambda: make_pipeline(StandardScaler(), Ridge(alpha=3.0)),
        "Gradient boosting": lambda: HistGradientBoostingRegressor(
            max_iter=250, learning_rate=0.04, max_depth=3, min_samples_leaf=30, random_state=SEED),
    }

    for split, train, df in (("validation", tr, va), ("test", trva, te)):
        for name, p in baselines(train, df).items():
            record("player_ga90", name, "baseline", split,
                   mae=wmae(df.target, p, df.target_minutes), n=len(df))

    val = {}
    for name, make in cands.items():
        m = make().fit(tr[PLAYER_FEATURES], tr.target, **_w(make, tr))
        val[name] = wmae(va.target, m.predict(va[PLAYER_FEATURES]), va.target_minutes)
        record("player_ga90", name, "candidate", "validation", mae=val[name], n=len(va))
    chosen = min(val, key=val.get)

    test_resid = None
    for name, make in cands.items():
        m = make().fit(trva[PLAYER_FEATURES], trva.target, **_w(make, trva))
        p = m.predict(te[PLAYER_FEATURES])
        record("player_ga90", name, "selected" if name == chosen else "candidate", "test",
               mae=wmae(te.target, p, te.target_minutes), n=len(te))
        if name == chosen:
            test_resid = te.target.values - p

    final = cands[chosen]().fit(labelled[PLAYER_FEATURES], labelled.target, **_w(cands[chosen], labelled))
    lo, hi = np.quantile(test_resid, [0.1, 0.9])

    latest = int(ps.season.max())
    cur = ps[(ps.season == latest) & (ps.minutes >= 450)].copy()
    cur["pred_ga_p90"] = np.clip(final.predict(cur[PLAYER_FEATURES]), 0, None)
    cur["pred_lo"] = np.clip(cur.pred_ga_p90 + lo, 0, None)
    cur["pred_hi"] = cur.pred_ga_p90 + hi
    cur["low_sample"] = cur.minutes < MIN_MINUTES
    out = cur[["player_id", "season", "minutes", "ga_p90", "pred_ga_p90", "pred_lo", "pred_hi", "low_sample"]]
    out = out.rename(columns={"season": "base_season", "ga_p90": "base_ga_p90", "minutes": "base_minutes"})
    out["target_season"] = latest + 1
    out["model_version"] = VERSION

    registry.append({
        "task": "player_ga90", "selected_model": chosen, "version": VERSION,
        "target": "Next-season goals + assists per 90 (players with ≥900 min in both seasons)",
        "features": json.dumps(PLAYER_FEATURES),
        "train": f"target seasons ≤ {season_label(val_t[0] - 1)}",
        "validation": ", ".join(map(season_label, val_t)),
        "test": ", ".join(map(season_label, test_t)),
        "selection_metric": "minutes-weighted MAE (validation)",
        "notes": "Only league minutes are observed. Players who leave the league have no next-season "
                 "label, so the training set over-represents players who stayed. Interval = 10th–90th "
                 "percentile of test residuals.",
    })
    return out


def _w(make, df):
    est = make()
    step = est.steps[-1][0] if hasattr(est, "steps") else None
    key = f"{step}__sample_weight" if step else "sample_weight"
    return {key: df.target_minutes.values}


# =========================================================================
# Market value, 12 months ahead
# =========================================================================

VALUE_FEATURES = ["log_value", "log_change_12m", "has_change", "age", "minutes", "apps",
                  "ga_p90", "points_per_app", "prev_minutes",
                  "pos_Attack", "pos_Midfield", "pos_Defender", "pos_Goalkeeper"]


def value_snapshots(con, years) -> pd.DataFrame:
    """One row per (league player, 1 July snapshot) with features as of that date."""
    frames = []
    for y in years:
        snap = dt.date(y, 7, 1)
        df = con.execute("""
            with cur as (
                select player_id, arg_max(value_eur, date) v, max(date) d,
                       arg_max(competition_id, date) comp
                from valuations where date <= $snap and date > $snap - interval 365 day
                group by 1),
            prev as (
                select player_id, arg_max(value_eur, date) v
                from valuations where date <= $snap - interval 300 day
                  and date > $snap - interval 500 day group by 1),
            fut as (
                select player_id, arg_max(value_eur, date) v
                from valuations where date > $snap + interval 180 day
                  and date <= $snap + interval 365 day group by 1)
            select cur.player_id, cur.v as value_eur, prev.v as prev_value, fut.v as future_value,
                   p.position,
                   date_diff('day', p.date_of_birth, $snap::date) / 365.25 as age,
                   s.minutes, s.apps, s.ga_p90, s.points_per_app, s2.minutes as prev_minutes
            from cur
            join players p using (player_id)
            left join prev using (player_id)
            left join fut using (player_id)
            left join player_seasons s on s.player_id = cur.player_id and s.season = $season
            left join player_seasons s2 on s2.player_id = cur.player_id and s2.season = $season - 1
            where cur.comp = 'GB1' and p.position is not null
        """, {"snap": snap, "season": y - 1}).df()
        df["snapshot_year"] = y
        frames.append(df)
    df = pd.concat(frames, ignore_index=True)
    df["log_value"] = np.log(df.value_eur)
    df["log_change_12m"] = np.log(df.value_eur / df.prev_value)
    df["has_change"] = df.log_change_12m.notna().astype(int)
    df["log_change_12m"] = df.log_change_12m.fillna(0)
    for c in ["minutes", "apps", "prev_minutes"]:
        df[c] = df[c].fillna(0)
    df["ga_p90"] = df.ga_p90.where(df.minutes >= 450, 0).fillna(0)
    df["points_per_app"] = df.points_per_app.fillna(df.points_per_app.median())
    df["age"] = df.age.fillna(df.age.median())
    for pos in ["Attack", "Midfield", "Defender", "Goalkeeper"]:
        df[f"pos_{pos}"] = (df.position == pos).astype(int)
    df["target"] = np.log(df.future_value / df.value_eur)
    return df


def value_metrics(y, p, value):
    pct = np.abs(np.exp(p) - np.exp(y)) / np.exp(y)
    return {"mae_log": float(np.mean(np.abs(y - p))),
            "median_abs_pct_error": float(np.median(pct)),
            "mae_eur_m": float(np.mean(np.abs(value * np.exp(p) - value * np.exp(y))) / 1e6),
            "n": len(y)}


def train_values(con):
    max_date = con.sql("select max(date) from valuations").fetchall()[0][0]
    last_labelled = max_date.year - 1 if max_date < dt.date(max_date.year, 7, 1) + dt.timedelta(days=200) else max_date.year
    years = list(range(2014, last_labelled + 1))
    df = value_snapshots(con, years)
    lab = df[df.target.notna()]
    test_y = [last_labelled - 1, last_labelled]
    val_y = [last_labelled - 2]
    tr, va = lab[lab.snapshot_year < val_y[0]], lab[lab.snapshot_year.isin(val_y)]
    trva, te = lab[lab.snapshot_year < test_y[0]], lab[lab.snapshot_year.isin(test_y)]

    def age_bucket(a):
        return np.clip((a // 2) * 2, 16, 36)

    def baselines(train, d):
        by_age = train.groupby(age_bucket(train.age)).target.mean()
        return {"No change": np.zeros(len(d)),
                "Average change for age": age_bucket(d.age).map(by_age).fillna(0).values}

    def gbm():
        return HistGradientBoostingRegressor(max_iter=300, learning_rate=0.04, max_depth=4,
                                             min_samples_leaf=40, loss="absolute_error",
                                             random_state=SEED)

    for split, train, d in (("validation", tr, va), ("test", trva, te)):
        for name, p in baselines(train, d).items():
            record("market_value", name, "baseline", split, **value_metrics(d.target.values, p, d.value_eur.values))

    m = gbm().fit(tr[VALUE_FEATURES], tr.target)
    record("market_value", "Gradient boosting (absolute error)", "candidate", "validation",
           **value_metrics(va.target.values, m.predict(va[VALUE_FEATURES]), va.value_eur.values))
    m = gbm().fit(trva[VALUE_FEATURES], trva.target)
    p = m.predict(te[VALUE_FEATURES])
    record("market_value", "Gradient boosting (absolute error)", "selected", "test",
           **value_metrics(te.target.values, p, te.value_eur.values))
    resid = te.target.values - p
    lo, hi = np.quantile(resid, [0.1, 0.9])
    coverage = float(np.mean((resid >= lo) & (resid <= hi)))

    final = gbm().fit(lab[VALUE_FEATURES], lab.target)
    snap_year = max_date.year if max_date >= dt.date(max_date.year, 6, 1) else max_date.year - 1
    cur = value_snapshots(con, [snap_year + (1 if snap_year < max_date.year else 0)])
    cur = cur[cur.value_eur.notna()].copy()
    pred = final.predict(cur[VALUE_FEATURES])
    cur["pred_value_eur"] = cur.value_eur * np.exp(pred)
    cur["pred_lo_eur"] = cur.value_eur * np.exp(pred + lo)
    cur["pred_hi_eur"] = cur.value_eur * np.exp(pred + hi)
    snap = dt.date(int(cur.snapshot_year.iloc[0]), 7, 1)
    out = cur[["player_id", "value_eur", "pred_value_eur", "pred_lo_eur", "pred_hi_eur"]].copy()
    out["snapshot_date"], out["horizon_date"] = snap, dt.date(snap.year + 1, 7, 1)
    out["model_version"] = VERSION

    registry.append({
        "task": "market_value", "selected_model": "Gradient boosting (absolute error)", "version": VERSION,
        "target": "log change in recorded market value 12 months after a 1 July snapshot",
        "features": json.dumps(VALUE_FEATURES),
        "train": f"snapshots 2014 – {val_y[0] - 1}",
        "validation": ", ".join(map(str, val_y)),
        "test": ", ".join(map(str, test_y)),
        "selection_metric": "MAE of log change (validation)",
        "notes": f"Recorded market values are crowd-sourced estimates, not transfer fees. "
                 f"10–90% interval from test residuals; empirical coverage {coverage:.0%}. "
                 "Contract length, injuries and agent data are not historically available.",
    })
    return out


# =========================================================================

def main():
    MODELS.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(DB))
    team_state, oos, calib = train_matches(con)
    print("  ✓ match model")
    pf = train_players(con)
    print("  ✓ player model")
    vf = train_values(con)
    print("  ✓ value model")

    reg = pd.DataFrame(registry)
    reg["trained_at"] = dt.datetime.now().isoformat(timespec="seconds")
    tables = {"team_state": team_state, "match_predictions": oos, "calibration": calib,
              "player_forecasts": pf, "value_forecasts": vf,
              "model_runs": pd.DataFrame(runs), "model_registry": reg}
    for name, df in tables.items():
        con.register("df_tmp", df)
        con.execute(f"create or replace table {name} as select * from df_tmp")
        con.unregister("df_tmp")
    con.close()

    r = pd.DataFrame(runs)
    print(r[r.split == "test"].pivot_table(index=["task", "model"], columns="metric", values="value").round(4).to_string())


if __name__ == "__main__":
    main()
