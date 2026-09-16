#level beginner

# Reactors: interactive programs, shown right in this panel.
#
# A reactor is a *value*. Starting it with .interact() gives you a card with
# play / pause, single-step, and a slider you can drag backwards - the states
# it has been through are recorded, so you can rewind and play forward again.

scene = empty_scene(320, 140)

# animate(draw) is the quick way in: `n` counts ticks from 0.
animate(lambda n: place_image(circle(14, "solid", "crimson"), (n * 4) % 320, 70, scene))


# The long form spells out each handler. This one is driven by the arrow
# keys - click the picture first so it has the keyboard, then press them.
def move(position, key):
    x, y = position
    if key == "left":
        return (x - 12, y)
    if key == "right":
        return (x + 12, y)
    if key == "up":
        return (x, y - 12)
    if key == "down":
        return (x, y + 12)
    return position


reactor(
    init=(160, 70),
    to_draw=lambda position: place_image(
        star(18, "solid", "gold"), position[0], position[1], scene
    ),
    on_key=move,
    title="Arrow keys",
).interact()


# A reactor that stops on its own, and reports where it got to.
countdown = reactor(
    init=10,
    to_draw=lambda n: place_image(text(str(n), 48, "navy"), 160, 70, scene),
    on_tick=lambda n: n - 1,
    stop_when=lambda n: n <= 0,
    tick_rate=0.25,
    title="Countdown",
)
countdown.interact()

# ...and you can test the logic without watching it run at all.
print("countdown states:", countdown.simulate_trace(20).get_trace())
