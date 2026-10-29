"""Explicitly configured external data sources.

These are the only hosts JUEGO contacts. Nothing about the user is sent;
requests are plain anonymous GETs for public football datasets.
"""

# Transfermarkt-derived open dataset (CC0) maintained at
# https://github.com/dcaribou/transfermarkt-datasets
TRANSFERMARKT_BASE = "https://pub-e682421888d945d684bcae8890b0ec20.r2.dev/data"

TRANSFERMARKT_TABLES = [
    "competitions",
    "clubs",
    "players",
    "games",
    "appearances",
    "player_valuations",
    "transfers",
]

# Premier League competition id inside the Transfermarkt dataset.
COMPETITION_ID = "GB1"
