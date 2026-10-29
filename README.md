# JUEGO

A local, privacy-first football intelligence platform for the Premier League. It turns public historical data into player, team, match and transfer analysis, plus a set of predictive models that are evaluated in the open.

```bash
./run.sh            # first run: download data, build the database, train models, serve
./run.sh --rebuild  # refresh data and retrain
```

Then open http://127.0.0.1:8000. The API docs are at `/api/docs`.

## Architecture

```
pipeline/   sources.py   the only configured external data source
            fetch.py     download raw tables → data/raw/
            build.py     validate, clean, standardise → data/juego.duckdb
            features.py  leakage-safe pre-match features (Elo, form, attack/defence EWMA)
            match_models.py  outcome + Poisson goal models
            train.py     chronological train / validation / test, forecasts, model registry
backend/    app.py       FastAPI, read-only over DuckDB, serves the frontend
frontend/   index.html, styles.css, app.js, charts.js   vanilla JS, no dependencies
```

**Data:** [transfermarkt-datasets](https://github.com/dcaribou/transfermarkt-datasets) (CC0), covering league seasons 2012/13–2025/26: 5,320 matches, 149,751 appearances, 2,466 players, 60,682 market valuations and 14,800 transfers. Stable source ids (`player_id`, `club_id`, `match_id`) are kept so more competitions can be added. `COMPETITION_ID` in `sources.py` controls which league is built.

## Models

Each model is fit on earlier seasons, selected on a validation window, then scored once on held-out later seasons next to simple baselines. Every metric, split and feature list is written to the `model_runs` and `model_registry` tables and shown on the **Models** page.

| Task | Test seasons | Best baseline | Selected model |
|---|---|---|---|
| Match result (H/D/A) | 2024/25, 2025/26 | frequencies: log loss 1.083 | Elo logistic: log loss 1.007, RPS 0.206, accuracy 50.8% |
| Next-season G+A per 90 | 2024/25, 2025/26 | shrunk to position mean: MAE 0.093 | gradient boosting: MAE 0.094 |
| Market value in 12 months | 2024, 2025 snapshots | no change: median error 33% | gradient boosting: median error 23% |

The player model doesn't beat the shrinkage baseline, and the Models page says so.

## What the data does not contain

There's no xG, shot or event data, no starter/substitute split, no injuries, no defensive actions and no historical contract lengths. JUEGO doesn't estimate or imply any of these. Defenders and keepers are ranked partly on team outcomes (clean sheets, points), and the UI flags this. Market values are crowd-sourced estimates, not transfer fees.

## Privacy

- No accounts, cookies, analytics, ads or tracking. The server binds to `127.0.0.1` with access logging off, so search terms aren't written anywhere.
- A strict Content-Security-Policy restricts the page to its own origin, and `Referrer-Policy: no-referrer` is set.
- Player photos are left out on purpose, because loading them would contact a third-party image host.
- The only outbound requests are made by `pipeline/fetch.py`, and they go to the single source in `sources.py`.
- One thing is stored in the browser: the light/dark appearance choice, in `localStorage`.
