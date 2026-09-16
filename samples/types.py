#level beginner

# PLL checks type annotations while the program runs. Uncomment any of the
# lines marked BREAKS to see the error it reports, and where.

def book_cost(num_books: int, hardcover: bool) -> float:
    """Paperbacks cost $12; hardcovers cost $25."""
    if hardcover:
        return num_books * 25
    else:
        return num_books * 12


def initials(first: str, last: str) -> str:
    return first[0] + last[0]


def total_pages(pages: list[int]) -> int:
    return sum(pages)


print(book_cost(3, True))
print(initials("Ada", "Lovelace"))
print(total_pages([120, 340, 95]))

# An int is fine where a float is annotated, just as in normal Python.
print(book_cost(1, False))

# BREAKS: "three" is a string, but num_books is annotated int.
# print(book_cost("three", True))

# BREAKS: every item of pages has to be an int, not just the first.
# print(total_pages([120, "340", 95]))

# BREAKS: a variable's own annotation is checked too.
# shelf_count: int = "seven"
