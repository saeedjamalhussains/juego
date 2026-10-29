"""Match outcome models. Kept in their own module so pickled models load anywhere."""

import numpy as np
from scipy.stats import poisson
from sklearn.linear_model import LogisticRegression, PoissonRegressor
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from features import AWAY_GOAL_FEATURES, HOME_GOAL_FEATURES

CLASSES = np.array(["H", "D", "A"])
MAX_GOALS = 10


def score_matrix(lh: float, la: float) -> np.ndarray:
    g = np.arange(MAX_GOALS + 1)
    return np.outer(poisson.pmf(g, lh), poisson.pmf(g, la))


def matrix_outcomes(mat: np.ndarray) -> np.ndarray:
    return np.array([np.tril(mat, -1).sum(), np.trace(mat), np.triu(mat, 1).sum()])


class FrequencyModel:
    """Baseline: always predict the training-set H/D/A rates."""
    def fit(self, X, y):
        self.p = np.array([(y == c).mean() for c in CLASSES]); return self
    def predict_proba(self, X):
        return np.tile(self.p, (len(X), 1))


class LogitModel:
    def __init__(self, cols, C=1.0):
        self.cols, self.C = cols, C
    def fit(self, X, y):
        self.m = make_pipeline(StandardScaler(),
                               LogisticRegression(C=self.C, max_iter=2000))
        self.m.fit(X[self.cols], y); return self
    def predict_proba(self, X):
        p = self.m.predict_proba(X[self.cols])
        order = [list(self.m.classes_).index(c) for c in CLASSES]
        return p[:, order]


class PoissonModel:
    """Independent Poisson goals for each side; outcomes from the score grid."""
    def fit(self, X, y=None):
        self.h = make_pipeline(StandardScaler(), PoissonRegressor(alpha=1e-3, max_iter=1000))
        self.a = make_pipeline(StandardScaler(), PoissonRegressor(alpha=1e-3, max_iter=1000))
        self.h.fit(X[HOME_GOAL_FEATURES], X["home_goals"])
        self.a.fit(X[AWAY_GOAL_FEATURES], X["away_goals"]); return self
    def rates(self, X):
        return self.h.predict(X[HOME_GOAL_FEATURES]), self.a.predict(X[AWAY_GOAL_FEATURES])
    def predict_proba(self, X):
        lh, la = self.rates(X)
        return np.array([matrix_outcomes(score_matrix(a, b)) for a, b in zip(lh, la)])
