from cadgen import build123d as bd
from cadgen import glb, srgb, step, stl, threemf


def _box(size, center, color, label, radius=0.0):
    part = bd.Box(*size)
    if radius:
        part = part.fillet(radius, part.edges())
    part = part.moved(bd.Location(center))
    part.color = srgb(color)
    part.label = label
    return part


def _wheel(x, y, z, label):
    tire = bd.Cylinder(7.2, 4.2, rotation=(90, 0, 0))
    tire = tire.fillet(0.8, tire.edges())
    tire = tire.moved(bd.Location((x, y, z)))
    tire.color = srgb("#20252B")
    tire.label = label
    hub = bd.Cylinder(3.5, 4.4, rotation=(90, 0, 0))
    hub = hub.fillet(0.5, hub.edges())
    hub = hub.moved(bd.Location((x, y, z)))
    hub.color = srgb("#B9BEC2")
    hub.label = label + "_hub"
    return tire, hub


@step(out="STEP/taxi.step")
@stl(out="STL/taxi.stl", mesh_tolerance=0.001)
@threemf(out="3MF/taxi.3mf", mesh_tolerance=0.001)
@glb(out="GLB/taxi.glb", mesh_tolerance=0.001)
def taxi():
    parts = [
        _box((68, 34, 12), (0, 0, 11), "#F4F3EE", "lower_body", 4.5),
        _box((39, 29, 12), (-1, 0, 22), "#F7F6F0", "cabin_roof", 4.5),
        _box((2.2, 34.6, 2.2), (34, 0, 7), "#F4F3EE", "front_bumper", 0.8),
        _box((2.2, 34.6, 2.2), (-34, 0, 7), "#30363D", "rear_bumper", 0.8),
        _box((37, 1.2, 3.3), (-1, 17.2, 13), "#0B8C4B", "driver_side_stripe", 0.35),
        _box((37, 1.2, 3.3), (-1, -17.2, 13), "#0B8C4B", "passenger_side_stripe", 0.35),
        _box((18, 2.4, 0.7), (-1, 7.2, 28.45), "#0B8C4B", "driver_roof_stripe", 0.3),
        _box((18, 2.4, 0.7), (-1, -7.2, 28.45), "#0B8C4B", "passenger_roof_stripe", 0.3),
        _box((13, 0.8, 6), (-8.2, 14.3, 22), "#263A4C", "driver_rear_window", 0.25),
        _box((13, 0.8, 6), (7.2, 14.3, 22), "#263A4C", "driver_front_window", 0.25),
        _box((13, 0.8, 6), (-8.2, -14.3, 22), "#263A4C", "passenger_rear_window", 0.25),
        _box((13, 0.8, 6), (7.2, -14.3, 22), "#263A4C", "passenger_front_window", 0.25),
        _box((0.8, 20, 6), (17.9, 0, 22), "#263A4C", "windshield", 0.25),
        _box((0.8, 20, 6), (-20, 0, 22), "#263A4C", "rear_window", 0.25),
        _box((12, 8, 2.2), (0, 0, 29.5), "#FFC928", "taxi_roof_sign", 0.7),
        _box((2.4, 5, 3), (34.2, 11, 11), "#F8D34B", "right_headlamp", 0.8),
        _box((2.4, 5, 3), (34.2, -11, 11), "#F8D34B", "left_headlamp", 0.8),
        _box((2.4, 3, 4), (-34.2, 12, 11), "#D92727", "right_tail_lamp", 0.8),
        _box((2.4, 3, 4), (-34.2, -12, 11), "#D92727", "left_tail_lamp", 0.8),
        _box((2, 13, 3.4), (34.6, 0, 10.8), "#30363D", "front_grille", 0.5),
    ]

    for side, y in (("driver", 16.7), ("passenger", -16.7)):
        for x, wheel_name in ((-22, "rear"), (22, "front")):
            parts.extend(_wheel(x, y, 9, f"{side}_{wheel_name}_wheel"))
        parts.append(_box((4, 1.2, 0.9), (0, y, 17), "#41474D", f"{side}_door_handle", 0.25))

    return bd.Compound(children=parts, label="green_stripe_taxi")


if __name__ == "__main__":
    taxi()
