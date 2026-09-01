# pandas — StringIO always works; the URL tests PLL's network shim
# (desktop and web). In the browser the host must allow CORS.

import io
import pandas as pd

cars = pd.read_csv(io.StringIO("name,mpg\nvw,29\nhonda,33\nford,18\n"))
print(cars)
print("efficient:", cars[cars["mpg"] >= 30]["name"].tolist())

iris = pd.read_csv(
    "https://cdn.jsdelivr.net/gh/mwaskom/seaborn-data@master/iris.csv"
)
print(iris.head())
print(len(iris), "rows")
