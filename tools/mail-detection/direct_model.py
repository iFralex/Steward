"""Portable inference head for directly supervised encoder checkpoints."""
import numpy as np
from scipy.special import expit


class DirectHead:
    def __init__(self, weight, bias):
        self.weight = np.asarray(weight, dtype=np.float64).reshape(-1)
        self.bias = float(np.asarray(bias).reshape(-1)[0])
        self.n_features_in_ = len(self.weight)
        self.classes_ = np.asarray([0, 1])

    def predict_proba(self, features):
        positive = expit(np.asarray(features) @ self.weight + self.bias)
        return np.column_stack([1-positive, positive])
