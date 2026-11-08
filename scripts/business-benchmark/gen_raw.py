import json, random, datetime as dt
R = random.Random(20261108)
def d(x): return x.isoformat()

# 1. Retail order lines
regions = {'North': ['Leeds', 'York'], 'South': ['Brighton', 'Southampton'], 'East': ['Norwich', 'Cambridge'], 'West': ['Bristol', 'Exeter']}
cats = {'Electronics': [('Headphones', 79.0), ('Smart Speaker', 49.0), ('Tablet', 299.0), ('Charger', 19.0), ('Monitor', 179.0)],
        'Home': [('Lamp', 35.0), ('Cushion', 15.0), ('Kettle', 29.0), ('Rug', 89.0), ('Vase', 22.0)],
        'Clothing': [('T-Shirt', 12.0), ('Jeans', 45.0), ('Jacket', 95.0), ('Trainers', 65.0), ('Scarf', 18.0)],
        'Toys': [('Puzzle', 14.0), ('Board Game', 30.0), ('Robot Kit', 55.0), ('Teddy Bear', 20.0)],
        'Grocery': [('Coffee', 8.0), ('Tea', 4.5), ('Olive Oil', 9.0), ('Chocolate', 3.0)]}
rows = []; oid = 10000
start = dt.date(2024, 1, 1)
while len(rows) < 2400:
    oid += 1
    day = start + dt.timedelta(days=R.randrange(0, 547))  # to 2025-06-30
    region = R.choice(list(regions)); store = R.choice(regions[region])
    cust = f"C{R.randrange(1, 601):04d}"; channel = 'Online' if R.random() < 0.4 else 'In-store'
    for _ in range(R.choice([1, 1, 1, 2, 2, 3])):
        cat = R.choices(list(cats), weights=[3, 3, 4, 2, 3])[0]; prod, price = R.choice(cats[cat])
        qty = R.choice([1, 1, 1, 2, 2, 3, 4]); rev = round(qty * price, 2); cost = round(rev * R.uniform(0.45, 0.75), 2)
        rows.append({'Order ID': f"ORD-{oid}", 'Order Date': d(day), 'Customer ID': cust, 'Region': region, 'Store': store,
                     'Category': cat, 'Product': prod, 'Channel': channel, 'Quantity': qty, 'Unit Price': price,
                     'Revenue': rev, 'Cost': cost, 'Returned': 'Yes' if R.random() < 0.06 else 'No'})
json.dump(rows, open('raw_retail.json', 'w'))

# 2. Weekly store sales (Walmart-like)
rows = []; wk = dt.date(2010, 2, 5)
weeks = [wk + dt.timedelta(weeks=i) for i in range(143)]
holidays = {dt.date(2010, 2, 12), dt.date(2010, 9, 10), dt.date(2010, 11, 26), dt.date(2010, 12, 31), dt.date(2011, 2, 11), dt.date(2011, 9, 9), dt.date(2011, 11, 25), dt.date(2011, 12, 30), dt.date(2012, 2, 10), dt.date(2012, 9, 7)}
base = {s: R.uniform(0.5e6, 2.0e6) for s in range(1, 11)}
for w in weeks:
    for s in range(1, 11):
        seasonal = 1.25 if w.month == 12 else 0.95 if w.month in (1, 2) else 1.0
        sales = round(base[s] * seasonal * (1.07 if w in holidays else 1.0) * R.uniform(0.9, 1.1), 2)
        rows.append({'Store': s, 'Date': d(w), 'Weekly_Sales': sales, 'Holiday_Flag': 1 if w in holidays else 0,
                     'Temperature': round(R.uniform(20, 90), 2), 'Fuel_Price': round(R.uniform(2.6, 4.2), 3),
                     'CPI': round(R.uniform(126, 225), 3), 'Unemployment': round(R.uniform(4, 11), 3)})
json.dump(rows, open('raw_weekly.json', 'w'))

# 3. Appointments
places = ['JARDIM DA PENHA', 'MATA DA PRAIA', 'SANTOS DUMONT', 'CENTRO', 'ITARARÉ', 'JESUS DE NAZARETH', 'MARUÍPE', 'BONFIM']
rows = []
for i in range(4000):
    wait = 0 if R.random() < 0.33 else int(R.random() * R.random() * 90)
    booked = dt.date(2016, 3, 1) + dt.timedelta(days=R.randrange(0, 70)); day = booked + dt.timedelta(days=wait)
    age = R.randrange(0, 95); place = R.choice(places); sms = wait > 3 and R.random() < 0.55
    p = (0.05 if wait == 0 else 0.18 + wait / 250) - age / 1500 + (0.07 if place == 'SANTOS DUMONT' else 0)
    rows.append({'PatientId': 1_000_000 + R.randrange(0, 2600), 'AppointmentID': 5_600_000 + i, 'Gender': 'F' if R.random() < 0.65 else 'M',
                 'ScheduledDay': d(booked), 'AppointmentDay': d(day), 'Age': age, 'Neighbourhood': place,
                 'Scholarship': R.random() < 0.1, 'Hipertension': R.random() < 0.2, 'Diabetes': R.random() < 0.07,
                 'SMS_received': sms, 'Showed_up': not (R.random() < p), 'Date.diff': wait})
json.dump(rows, open('raw_appointments.json', 'w'))

# 4. Employees
depts = {'Sales': 42000, 'Engineering': 61000, 'Finance': 52000, 'Marketing': 46000, 'Operations': 38000, 'HR': 40000}
locs = ['London', 'Manchester', 'Leeds', 'Remote']
rows = []
for i in range(1200):
    dept = R.choice(list(depts)); level = R.choices([1, 2, 3, 4, 5], weights=[30, 30, 20, 13, 7])[0]
    years = R.randrange(0, 21); hire = dt.date(2025, 6, 30) - dt.timedelta(days=years * 365 + R.randrange(0, 365))
    salary = round(depts[dept] * (1 + 0.22 * (level - 1)) * R.uniform(0.9, 1.12) / 100) * 100
    overtime = R.random() < 0.28; rating = R.choices([1, 2, 3, 4, 5], weights=[5, 15, 45, 25, 10])[0]
    attr = R.random() < (0.10 + (0.12 if overtime else 0) + (0.08 if rating <= 2 else 0) - (0.04 if level >= 4 else 0))
    rows.append({'Employee ID': f"E{i + 1:05d}", 'Department': dept, 'Gender': R.choice(['Male', 'Female']), 'Age': R.randrange(21, 64),
                 'Hire Date': d(hire), 'Salary': salary, 'Performance Rating': rating, 'Overtime': 'Yes' if overtime else 'No',
                 'Attrition': 'Yes' if attr else 'No', 'Years at Company': years, 'Job Level': level, 'Location': R.choice(locs)})
json.dump(rows, open('raw_employees.json', 'w'))
print('ok')
