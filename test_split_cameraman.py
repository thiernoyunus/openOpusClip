"""Self-checks for the SPLIT layout's panel framing (main.py SplitCameraman).

Run: .venv/bin/python test_split_cameraman.py

Guards the two things the zoom lock can get wrong:
  - a still subject must not breathe (that's the whole point of the lock), and
  - a panel must never inherit the PREVIOUS scene's zoom, which is what happens
    if its face isn't detected on the exact frame of the cut.
"""
from main import SplitCameraman

VW, VH = 1920, 1080
PANEL_ASPECT = 1080 / 960  # one panel of a 1080x1920 split


def face(cx, h_frac):
    """A face box centred at cx whose height is h_frac of the frame."""
    h = VH * h_frac
    w = h * 0.55
    return {'box': [cx - w / 2, VH * 0.3, w, h]}


def zooms(cam):
    """The panels' locked crop heights. get_crops() rounds to whole pixels, so
    a panel that merely PANS can report a 1px different height — read the
    camera's own state instead of inferring zoom from the rect."""
    return [None if s is None else round(s['ch'], 6) for s in cam.slots]


def test_zoom_holds_while_the_detected_face_size_wobbles():
    cam = SplitCameraman(VW, VH, PANEL_ASPECT)
    cam.update([face(500, 0.18), face(1400, 0.18)], force_snap=True)
    locked = zooms(cam)
    for i in range(60):
        wobble = 0.18 * (1.04 if i % 2 else 0.96)
        cam.update([face(500, wobble), face(1400, wobble)])
        assert zooms(cam) == locked, f"panel zoom drifted on frame {i}"


def test_a_panel_missing_at_the_cut_still_reframes_when_its_face_appears():
    """The regression the zoom lock introduced: force_snap only reaches slots
    that have a face on that exact frame."""
    cam = SplitCameraman(VW, VH, PANEL_ASPECT)
    # Scene 1: two close-up faces.
    cam.update([face(500, 0.30), face(1400, 0.30)], force_snap=True)
    scene1 = zooms(cam)

    # Scene 2 (wide shot, small faces): only the left face is detected at the cut.
    cam.update([face(400, 0.10)], force_snap=True)
    # Right face shows up on the next detection.
    cam.update([face(400, 0.10), face(1500, 0.10)])

    scene2 = zooms(cam)
    assert scene2[0] != scene1[0], "left panel kept the old scene's zoom"
    assert scene2[1] != scene1[1], "right panel kept the old scene's zoom"
    # Both panels framed the same shot, so they agree.
    assert abs(scene2[0] - scene2[1]) < 1e-6, f"panels disagree on the shot: {scene2}"


def test_a_lone_detection_lands_in_its_own_panel():
    """The symmetric case: if only the RIGHT participant is seen at the cut, it
    must not define the LEFT panel's zoom (sorted order would index it as 0).

    The two participants sit at different distances, so borrowing the wrong
    one's size is visible: the far speaker's panel would be zoomed as if their
    face filled the frame.
    """
    FAR, NEAR = 0.09, 0.28  # face heights: left is distant, right is close
    for present, label in ((1, 'right'), (0, 'left')):
        absent = 1 - present
        cam = SplitCameraman(VW, VH, PANEL_ASPECT)
        cam.update([face(500, 0.30), face(1400, 0.30)], force_snap=True)
        scene1 = zooms(cam)

        # New scene. Only one participant is detected on the frame of the cut.
        lone = face(1500, NEAR) if present == 1 else face(400, FAR)
        cam.update([lone], force_snap=True)
        assert cam.slots[present]['ch'] != scene1[present], (
            f"{label} panel did not take the lone detection")
        assert cam.pending_snap[absent], (
            f"the {label}-only detection consumed the other panel's snap")

        # The other participant appears a detection later and frames itself.
        cam.update([face(400, FAR), face(1500, NEAR)])
        left, right = zooms(cam)
        assert right > left * 2, (
            f"after a {label}-only cut the panels share one zoom: {(left, right)}")
        assert left != scene1[0] and right != scene1[1], (
            "a panel kept the old scene's zoom")


def test_a_slot_snaps_once_and_then_holds():
    cam = SplitCameraman(VW, VH, PANEL_ASPECT)
    cam.update([face(500, 0.20), face(1400, 0.20)], force_snap=True)
    snapped = zooms(cam)
    # A later, genuinely bigger face must NOT re-snap: the scene is locked.
    for _ in range(10):
        cam.update([face(500, 0.40), face(1400, 0.40)])
    assert zooms(cam) == snapped, "zoom re-snapped without a scene cut"


def test_panning_follows_a_real_move_slowly():
    cam = SplitCameraman(VW, VH, PANEL_ASPECT)
    cam.update([face(400, 0.20), face(1400, 0.20)], force_snap=True)
    start_x = cam.get_crops()[0][0]
    for _ in range(3):  # ~3 processed frames: barely moves
        cam.update([face(900, 0.20), face(1400, 0.20)])
    assert cam.get_crops()[0][0] - start_x < 100, "pan is not slow"
    for _ in range(200):  # eventually gets there
        cam.update([face(900, 0.20), face(1400, 0.20)])
    assert abs(cam.slots[0]['cx'] - 900) < 5, "pan never arrived"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"  ok  {name}")
    print("test_split_cameraman: all assertions passed")
