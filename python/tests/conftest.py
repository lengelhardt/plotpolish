import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt  # noqa: E402
import pytest  # noqa: E402


@pytest.fixture(autouse=True)
def clean_matplotlib():
    """Every test starts from library defaults with no open figures."""
    plt.close("all")
    matplotlib.rcdefaults()
    yield
    plt.close("all")
    matplotlib.rcdefaults()
