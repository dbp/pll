#intermediate

# Bonnie tables: a small Pyret-style tabular data type with simple
# functional operations and built-in charts.
#
# Every operation returns a *new* table; tables are immutable. The
# methods are chainable so you can build a pipeline reads top-to-bottom.

people = table(
    ["name", "age", "city"],
    [
        ["Alice",   30, "NYC"],
        ["Bob",     25, "LA"],
        ["Carol",   35, "NYC"],
        ["Diego",   28, "Chicago"],
        ["Eun-ji",  41, "LA"],
        ["Femi",    22, "NYC"],
    ],
)

people  # auto-displays as a table card

# Inspection -----------------------------------------------------------

print("columns:", people.columns())
print("number of rows:", people.length())
print("Alice's row:", people.row(0))
print("ages:", people.column("age"))

# Aggregations ---------------------------------------------------------

print("total age:", people.sum("age"))
print("average age:", people.mean("age"))
print("youngest:", people.min("age"))
print("oldest:", people.max("age"))

# Functional ops -------------------------------------------------------

# Filter: keep rows where the predicate is True.
adults_in_NYC = people.filter(lambda r: r["city"] == "NYC")
adults_in_NYC

# Transform: replace a column with the result of fn(value) per cell.
older = people.transform_column("age", lambda a: a + 1)

# Add column: list-of-values OR fn(row).
labelled = people.add_column(
    "label",
    lambda r: r["name"] + " (" + r["city"] + ")",
)
labelled

# Sort, pick columns, head/tail.
oldest_first = people.order_by("age", ascending=False).select_columns(["name", "age"]).head(3)
oldest_first

# Charts ---------------------------------------------------------------
# Charts return Image-compatible objects, so they auto-display inline
# next to your tables and printed text - in the order your code emits
# them.

people.bar_chart("name", "age", title="Age by person")

# Scatter / line need numeric axes on both sides.
points = table(
    ["x", "y"],
    [[i, i * i - 4 * i + 2] for i in range(1, 11)],
)
points.scatter_chart("x", "y", title="y = x^2 - 4x + 2 (scatter)")
points.line_chart("x", "y", title="y = x^2 - 4x + 2 (line)")

# Histogram of a numeric column.
people.histogram("age", bins=5, title="Age distribution")
