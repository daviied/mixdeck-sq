"""Paths the browser may write. The UI uses X32-shaped paths; app/sq.py maps them onto the SQ."""
import re

WRITE_OK = re.compile(r"^/(ch|fxrtn|bus|mtx)/\d\d/[a-z0-9/]+$|^/main/st/[a-z0-9/]+$|^/dca/[1-8]/[a-z/]+$"
                      r"|^/headamp/\d{3}/(gain|phantom)$|^/config/mute/[1-8]$")
