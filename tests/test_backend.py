"""Driver against the simulator. Run: python tests/test_backend.py"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))
import sim  # noqa: E402
import sq  # noqa: E402


def wait(fn, t=5.0):
    end = time.time() + t
    while time.time() < end:
        if fn():
            return True
        time.sleep(0.05)
    return False


def main():
    # Protocol document examples
    assert sq.nrpn_set(0, sq.MAP["/ch/01/mix/fader"][0], sq.lvl_out(sq.db_to_fader(0))) == bytes.fromhex("B06340B06200B00676B0265C")
    assert sq.MAP["/ch/40/mix/05/level"][0] == sq.P(0x44, 0x1C)
    assert sq.MAP["/ch/36/mix/15/level"][0] == sq.P(0x4D, 0x22)  # Ip36 to FX3
    assert sq.MAP["/ch/24/mix/05/pan"][0] == sq.P(0x52, 0x5C)
    assert sq.MAP["/config/mute/4"][0] == sq.P(0x04, 0x03)
    assert sq.MAP["/main/st/mix/on"][0] == sq.P(0x00, 0x44)
    print("tables ok")

    s = sim.SQSim()
    c = sq.SQ("A", "127.0.0.1", midi_port=s.mport, native_port=s.nport)
    assert wait(lambda: c.midi_ok and c.native_ok), c.status()
    assert wait(lambda: c.snapshot().get("/ch/01/config/name") == "Kick"), "names from native state"
    assert wait(lambda: c.snapshot()["/ch/01/mix/fader"] > .5), "fader read over MIDI"
    st = c.snapshot()
    assert abs(sq.SC["ha"][0](st["/headamp/001/gain"]) - 21) < .1, st["/headamp/001/gain"]
    print("read ok")

    c.write("/ch/02/mix/on", 0)
    assert wait(lambda: s.midi[sq.MAP["/ch/02/mix/on"][0]] == 1), "mute over MIDI"
    c.write("/ch/03/gate/on", 1)
    assert wait(lambda: s.native.get((0x0F, 0x0C, 2)) == 1), "gate over native"
    c.write("/ch/03/config/name", "Snr Top")
    assert wait(lambda: s.names.get(2) == "Snr To"), s.names.get(2)
    s.desk_midi("/ch/05/mix/fader", sq.db_to_fader(-10))
    assert wait(lambda: abs(sq.fader_to_db(c.snapshot()["/ch/05/mix/fader"]) + 10) < .2)
    s.desk_native("/ch/05/eq/2/g", sq.SC["g"][1](6))
    assert wait(lambda: abs(sq.SC["g"][0](c.snapshot()["/ch/05/eq/2/g"]) - 6) < .1)
    print("write and desk ok")

    caps = []
    for b3 in (0, 1, 2):
        c.capture = []
        time.sleep(.3)
        s.press_sel(b3)
        time.sleep(.9)
        caps.append(c.capture)
        c.capture = None
    pat = sq.learn_pattern(caps)
    assert pat, "learn"
    c.sel_pat = pat
    s.press_sel(0x58)
    assert wait(lambda: c.snapshot()["/-stat/sel"] == "/bus/01")
    s.press_sel(6)
    assert wait(lambda: c.snapshot()["/-stat/sel"] == "/ch/07")
    print("select learn ok", pat)
    assert wait(lambda: c.udp_stats["meters"] > 3 and c.udp_stats["rta"] > 1), c.udp_stats
    assert len(c.meter_bytes) == sq.METER_LEN and len(c.rta_bytes) == 100
    print("meters ok", c.udp_stats["sizes"])
    c.stop()
    print("all ok")


if __name__ == "__main__":
    main()
