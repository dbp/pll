# PLL's matplotlib backend, `module://_pll_matplotlib` (set as MPLBACKEND
# by the install step). Agg draws; `show()` puts each open figure where the
# program's other pictures go - the interactions panel, or the command
# line's output - and closes it, as a notebook does.
#
# Pyodide's own backend draws into a web page's `document`, which a worker
# does not have, so without this `plt.plot` failed with "cannot import name
# 'document' from 'js'".
#
# `_pll_show_figure` is PLL's, put in this module's namespace before it runs.

from matplotlib._pylab_helpers import Gcf
from matplotlib.backend_bases import FigureManagerBase as FigureManager
from matplotlib.backends.backend_agg import FigureCanvasAgg as FigureCanvas


def show(*args, **kwargs):
    for manager in Gcf.get_all_fig_managers():
        _pll_show_figure(manager.canvas.figure)
    Gcf.destroy_all()
