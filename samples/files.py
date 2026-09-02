# Sibling-folder files: open() and pandas both see cars.csv next to
# this script. After the run, efficient_cars.csv appears in this folder.

import pandas as pd

with open("cars.csv", "r") as f:
    lines = f.readlines()

print("header:", lines[0].strip())
print("rows:", len(lines) - 1)

with open("efficient_cars.csv", "w") as f:
    f.write(lines[0])
    for line in lines[1:]:
        _name, mpg = line.strip().split(",")
        if int(mpg) >= 30:
            f.write(line)

print("wrote efficient_cars.csv")

df = pd.read_csv("cars.csv")
print(df)
efficient = df[df["mpg"] >= 30]
efficient.to_csv("efficient_pandas.csv", index=False)
print("wrote efficient_pandas.csv")
