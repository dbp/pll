#level intermediate

# A *world*: a reactor that also talks to a universe server.
#
# Intermediate, not beginner, because `draw` builds its picture by rebinding
# `picture` in a loop - which beginner deliberately forbids.
#
# Students write worlds. The server is an ordinary program the course runs -
# there is a reference one next to this file. Start it first:
#
#     node universe_server.mjs
#
# then run this file. Open the same file in a second editor (or a second
# browser tab) and the two worlds will see each other move.

scene = empty_scene(320, 160)

STEP = 14


def draw(state):
    picture = place_image(circle(12, "solid", "crimson"), state["me"][0], state["me"][1], scene)
    for spot in state["others"]:
        picture = place_image(circle(9, "solid", "steelblue"), spot[0], spot[1], picture)
    return picture


def nudge(spot, key):
    x, y = spot
    if key == "left":
        return (max(0, x - STEP), y)
    if key == "right":
        return (min(320, x + STEP), y)
    if key == "up":
        return (x, max(0, y - STEP))
    if key == "down":
        return (x, min(160, y + STEP))
    return spot


def on_arrow(state, key):
    moved = nudge(state["me"], key)
    if moved == state["me"]:
        return state
    # package(...) returns the new state *and* sends a message to the server.
    return package({"me": moved, "others": state["others"]}, {"at": list(moved)})


def on_news(state, message):
    # Whatever the server sends arrives here. Our reference server relays
    # {"from": ..., "message": ...}, and greets each world with a "welcome".
    body = message.get("message") if isinstance(message, dict) else None
    if isinstance(body, dict) and "at" in body:
        spot = (body["at"][0], body["at"][1])
        return {"me": state["me"], "others": [spot]}
    return state


reactor(
    init={"me": (160, 80), "others": []},
    to_draw=draw,
    on_key=on_arrow,
    on_receive=on_news,
    register="ws://localhost:8080",
    title="Shared world - click the picture, then use the arrow keys",
).interact()
