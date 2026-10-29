"""Leakage-safe, pre-match team features.

Every feature for a match is computed from matches strictly before it, so
the row could have been produced on the morning of the fixture.
"""

from collections import defaultdict, deque

import numpy as np
import pandas as pd

ELO_START = 1500.0
ELO_PROMOTED = 1420.0      # promoted sides start below the league mean
ELO_K = 20.0
ELO_HOME = 60.0
ELO_SEASON_REGRESS = 0.25  # pull ratings a quarter of the way back to 1500 each summer
FORM_N = 6                 # matches in the short-form window
EWMA_ALPHA = 0.06          # ~11-match half-life for attack/defence strength


class TeamState:
    """Rolling state for one club, advanced one match at a time."""

    def __init__(self, elo: float):
        self.elo = elo
        self.points = deque(maxlen=FORM_N)
        self.gf = deque(maxlen=FORM_N)
        self.ga = deque(maxlen=FORM_N)
        self.att = 1.4   # EWMA goals scored per match
        self.dfn = 1.4   # EWMA goals conceded per match
        self.played = 0

    def snapshot(self) -> dict:
        n = len(self.points)
        return {
            "elo": self.elo,
            "form_ppg": (sum(self.points) / n) if n else 1.3,
            "form_gf": (sum(self.gf) / n) if n else 1.3,
            "form_ga": (sum(self.ga) / n) if n else 1.4,
            "att": self.att,
            "dfn": self.dfn,
            "played": self.played,
        }


def _elo_expected(home: float, away: float) -> float:
    return 1.0 / (1.0 + 10 ** ((away - (home + ELO_HOME)) / 400.0))


def build_match_features(matches: pd.DataFrame):
    """Return (feature frame, final team states) for chronologically sorted matches."""
    m = matches.sort_values(["date", "match_id"]).reset_index(drop=True)
    teams: dict[int, TeamState] = {}
    last_season_seen: dict[int, int] = {}
    current_season = None
    rows = []

    for r in m.itertuples(index=False):
        if r.season != current_season:
            # Summer: regress everyone toward the mean.
            for t in teams.values():
                t.elo = t.elo + ELO_SEASON_REGRESS * (ELO_START - t.elo)
            current_season = r.season
        for club in (r.home_id, r.away_id):
            if club not in teams:
                first = current_season == m.season.min()
                teams[club] = TeamState(ELO_START if first else ELO_PROMOTED)
            elif last_season_seen.get(club, r.season) < r.season - 1:
                # Returning after time away: treat like a promoted side.
                teams[club].elo = min(teams[club].elo, ELO_PROMOTED)
            last_season_seen[club] = r.season

        h, a = teams[r.home_id], teams[r.away_id]
        hs, as_ = h.snapshot(), a.snapshot()
        row = {"match_id": r.match_id, "date": r.date, "season": r.season,
               "home_id": r.home_id, "away_id": r.away_id,
               "home_goals": r.home_goals, "away_goals": r.away_goals, "result": r.result}
        row.update(pair_features(hs, as_))
        rows.append(row)

        # ---- update after the match ----
        exp_h = _elo_expected(h.elo, a.elo)
        score_h = 1.0 if r.result == "H" else 0.5 if r.result == "D" else 0.0
        margin = abs(r.home_goals - r.away_goals)
        mult = np.log1p(margin) + 1.0 if margin else 1.0
        delta = ELO_K * mult * (score_h - exp_h)
        h.elo += delta
        a.elo -= delta
        for t, gf, ga in ((h, r.home_goals, r.away_goals), (a, r.away_goals, r.home_goals)):
            t.points.append(3 if gf > ga else 1 if gf == ga else 0)
            t.gf.append(gf)
            t.ga.append(ga)
            t.att += EWMA_ALPHA * (gf - t.att)
            t.dfn += EWMA_ALPHA * (ga - t.dfn)
            t.played += 1

    return pd.DataFrame(rows), teams


def pair_features(h: dict, a: dict) -> dict:
    """Features for a home/away pairing, from each side's snapshot."""
    return {
        "elo_home": h["elo"], "elo_away": a["elo"],
        "elo_diff": (h["elo"] + ELO_HOME) - a["elo"],
        "form_ppg_diff": h["form_ppg"] - a["form_ppg"],
        "form_gd_diff": (h["form_gf"] - h["form_ga"]) - (a["form_gf"] - a["form_ga"]),
        "home_att": h["att"], "home_dfn": h["dfn"],
        "away_att": a["att"], "away_dfn": a["dfn"],
    }


OUTCOME_FEATURES = ["elo_diff", "form_ppg_diff", "form_gd_diff",
                    "home_att", "home_dfn", "away_att", "away_dfn"]
HOME_GOAL_FEATURES = ["elo_diff", "home_att", "away_dfn"]
AWAY_GOAL_FEATURES = ["elo_diff", "away_att", "home_dfn"]
