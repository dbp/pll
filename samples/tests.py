#beginner

def add(x, y):
    return x + y


def test_add_positive():
    assert add(2, 3) == 5


def test_add_zero():
    assert add(0, 4) == 4


class TestAdd:
    def test_negative(self):
        assert add(-1, -2) == -3


add(10, 20)
