"""Seeded raw exports for the owner benchmark, laid out like the real thing.

  cafe_square_items.csv  Square "Item sales" export: two sites, 4 months to Wed 4 Nov 2026,
                         £ amounts, discounts, refunds as negative lines, dine-in/takeaway,
                         times of day, repeat customers (card-on-file IDs, many blank).
  shop_till_export.csv   A till export (Epos/Lightspeed style): receipts with several lines,
                         cost price per unit, staff, card/cash, UK dates (DD/MM/YYYY).
  shopify_orders.csv     Shopify orders export: order fields only on the first line, discount
                         codes, refunds, shipping, repeat customers by email, 12 months.
No real people: names and emails are made up.
"""
import csv, random, datetime as dt, os, sys
OUT = sys.argv[1] if len(sys.argv) > 1 else '.'
END = dt.date(2026, 11, 4)  # a Wednesday

def money(x):
    return ('-' if x < 0 else '') + f'£{abs(x):,.2f}'

# ── Café (Square) ─────────────────────────────────────────────
random.seed(101)
menu = [  # category, item, price, popularity
    ('Coffee', 'Flat White', 3.40, 14), ('Coffee', 'Latte', 3.50, 12), ('Coffee', 'Cappuccino', 3.40, 9),
    ('Coffee', 'Americano', 2.90, 8), ('Coffee', 'Espresso', 2.40, 3), ('Coffee', 'Oat Milk Latte', 3.90, 6),
    ('Tea', 'English Breakfast', 2.50, 5), ('Tea', 'Chai Latte', 3.60, 4),
    ('Food', 'Bacon Roll', 4.80, 6), ('Food', 'Avocado Toast', 7.50, 4), ('Food', 'Soup of the Day', 5.90, 4),
    ('Food', 'Ham & Cheese Toastie', 6.20, 5), ('Pastry', 'Croissant', 2.80, 8), ('Pastry', 'Pain au Chocolat', 3.10, 5),
    ('Pastry', 'Cinnamon Bun', 3.40, 5), ('Cold Drinks', 'Orange Juice', 2.90, 3), ('Cold Drinks', 'Sparkling Water', 1.90, 3),
]
weights = [m[3] for m in menu]
start = dt.date(2026, 7, 6)
rows = []
txn = 0
customers = [f'CUST-{i:04d}' for i in range(1, 400)]
for d in range((END - start).days + 1):
    day = start + dt.timedelta(days=d)
    for loc, open_h, close_h, closed_sun, base in [('Station', 7, 17, False, 70), ('Market Street', 8, 18, True, 55)]:
        if closed_sun and day.weekday() == 6: continue
        n = base + (25 if day.weekday() == 5 else 0) - (15 if day.weekday() == 6 else 0) + random.randint(-10, 10)
        if day.month == 8: n = int(n * 0.85)  # quieter summer holidays
        if day == dt.date(2026, 10, 29) and loc == 'Market Street': n = int(n * 0.4)  # roadworks Thursday
        for _ in range(n):
            txn += 1
            hour = random.choices(range(open_h, close_h), weights=[3 if h in (8, 12, 13) else 1 for h in range(open_h, close_h)])[0]
            t = dt.time(hour, random.randint(0, 59), random.randint(0, 59))
            cust = random.choice(customers) if random.random() < 0.35 else ''
            dining = random.choice(['For Here', 'To Go', 'To Go'])
            for _ in range(random.choices([1, 2, 3], weights=[5, 4, 1])[0]):
                cat, item, price, _w = random.choices(menu, weights=weights)[0]
                if item == 'Oat Milk Latte' and day >= dt.date(2026, 10, 26) and day <= dt.date(2026, 11, 1): continue  # ran out
                qty = 1 if random.random() < 0.9 else 2
                gross = round(price * qty, 2)
                disc = round(-gross * 0.1, 2) if random.random() < 0.08 else 0.0
                net = round(gross + disc, 2)
                tax = round(net / 6, 2) if cat in ('Food', 'Coffee', 'Tea') and dining == 'For Here' else 0.0
                rows.append({'Date': day.isoformat(), 'Time': t.strftime('%H:%M:%S'), 'Time Zone': 'Europe/London', 'Category': cat, 'Item': item,
                             'Qty': qty, 'Price Point Name': 'Regular', 'Gross Sales': money(gross), 'Discounts': money(disc), 'Net Sales': money(net), 'Tax': money(tax),
                             'Transaction ID': f'T{txn:07d}', 'Event Type': 'Payment', 'Location': loc, 'Dining Option': dining, 'Customer ID': cust, 'Channel': 'Square Point of Sale'})
# refunds: 0.5% of lines come back as negative lines on the same or next day
for r in random.sample(rows, len(rows) // 200):
    rr = dict(r); rr['Event Type'] = 'Refund'; rr['Qty'] = -r['Qty']
    for k in ('Gross Sales', 'Discounts', 'Net Sales', 'Tax'):
        v = float(r[k].replace('£', '').replace(',', '')); rr[k] = money(-v)
    rows.append(rr)
rows.sort(key=lambda r: (r['Date'], r['Time']))
with open(os.path.join(OUT, 'cafe_square_items.csv'), 'w', newline='') as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
print('cafe', len(rows))

# ── Shop (till export, UK dates) ──────────────────────────────
random.seed(202)
products = [  # department, product, price, cost, popularity
    ('Gifts', 'Scented Candle', 14.00, 5.20, 6), ('Gifts', 'Greeting Card', 3.50, 0.90, 14), ('Gifts', 'Gift Wrap', 2.00, 0.40, 8),
    ('Homeware', 'Ceramic Mug', 9.50, 3.10, 9), ('Homeware', 'Linen Tea Towel', 8.00, 2.60, 6), ('Homeware', 'Cushion Cover', 18.00, 6.50, 3),
    ('Stationery', 'Notebook A5', 6.50, 2.10, 10), ('Stationery', 'Fountain Pen', 24.00, 9.80, 2), ('Stationery', 'Wall Calendar', 12.00, 4.00, 4),
    ('Toys', 'Wooden Puzzle', 15.00, 6.00, 4), ('Toys', 'Plush Bear', 12.50, 4.50, 5),
    ('Food & Drink', 'Artisan Chocolate', 5.50, 2.40, 9), ('Food & Drink', 'Loose Leaf Tea', 7.00, 2.80, 5),
]
pw = [p[4] for p in products]
staff = ['Amira', 'Ben', 'Chloe', 'Dev']
rows = []
receipt = 50000
start = dt.date(2026, 5, 4)
for d in range((END - start).days + 1):
    day = start + dt.timedelta(days=d)
    if day.weekday() == 0: continue  # closed Mondays
    n = 35 + (30 if day.weekday() == 5 else 0) + (40 if day.month == 11 else 0) + random.randint(-8, 8)
    for _ in range(n):
        receipt += 1
        hour = random.randint(9, 16)
        pay = 'Cash' if random.random() < 0.18 else 'Card'
        who = staff[(day.toordinal() + hour) % 4]
        for _ in range(random.choices([1, 2, 3, 4], weights=[5, 3, 2, 1])[0]):
            dept, prod, price, cost, _w = random.choices(products, weights=pw)[0]
            qty = random.choices([1, 2, 3], weights=[8, 2, 1])[0]
            disc = round(price * qty * 0.15, 2) if random.random() < 0.06 else 0.0
            rows.append({'Date': day.strftime('%d/%m/%Y'), 'Time': f'{hour:02d}:{random.randint(0, 59):02d}', 'Receipt No': receipt, 'Department': dept, 'Product': prod,
                         'Qty': qty, 'Unit Price': f'{price:.2f}', 'Cost Price': f'{cost:.2f}', 'Discount': f'{disc:.2f}', 'Line Total': f'{price * qty - disc:.2f}',
                         'Payment Type': pay, 'Staff': who})
with open(os.path.join(OUT, 'shop_till_export.csv'), 'w', newline='') as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
print('shop', len(rows))

# ── Online shop (Shopify orders export) ───────────────────────
random.seed(303)
catalogue = [('Organic Cotton Tee', 22.00, 'Apparel'), ('Recycled Hoodie', 48.00, 'Apparel'), ('Canvas Tote', 15.00, 'Bags'),
             ('Enamel Pin', 6.00, 'Accessories'), ('Wool Beanie', 18.00, 'Accessories'), ('Travel Mug', 16.00, 'Homeware'),
             ('Print A3', 25.00, 'Homeware'), ('Gift Card £25', 25.00, 'Gift Cards')]
cw = [10, 4, 8, 6, 5, 6, 3, 2]
cities = ['London', 'Manchester', 'Bristol', 'Leeds', 'Glasgow', 'Edinburgh', 'Cardiff', 'Brighton']
countries = ['GB'] * 9 + ['IE', 'DE', 'FR', 'US']
emails = [f'customer{i}@example.com' for i in range(1, 1300)]
rows = []
order = 1000
start = dt.date(2025, 11, 5)
for d in range((END - start).days + 1):
    day = start + dt.timedelta(days=d)
    n = random.randint(3, 9) + (12 if day.month in (11, 12) and day.day >= 20 or (day.month == 12 and day.day < 20) else 0)
    for _ in range(n):
        order += 1
        email = random.choice(emails[:300]) if random.random() < 0.4 else random.choice(emails)
        country = random.choice(countries)
        code = random.choice(['WELCOME10', 'SUMMER15', '']) if random.random() < 0.25 else ''
        lines = []
        for _ in range(random.choices([1, 2, 3], weights=[6, 3, 1])[0]):
            name, price, ptype = random.choices(catalogue, weights=cw)[0]
            qty = 1 if random.random() < 0.85 else 2
            lines.append((name, price, qty, ptype))
        subtotal = sum(p * q for _, p, q, _t in lines)
        disc = round(subtotal * (0.10 if code == 'WELCOME10' else 0.15 if code == 'SUMMER15' else 0), 2)
        shipping = 0.0 if subtotal - disc >= 50 else (3.95 if country == 'GB' else 9.95)
        total = round(subtotal - disc + shipping, 2)
        refunded = round(total, 2) if random.random() < 0.04 else 0.0
        status = 'refunded' if refunded else 'paid'
        when = dt.datetime.combine(day, dt.time(random.randint(0, 23), random.randint(0, 59), random.randint(0, 59)))
        for k, (name, price, qty, ptype) in enumerate(lines):
            first = k == 0
            rows.append({
                'Name': f'#{order}', 'Email': email if first else '', 'Financial Status': status if first else '', 'Paid at': when.strftime('%Y-%m-%d %H:%M:%S +0000') if first else '',
                'Currency': 'GBP' if first else '', 'Subtotal': f'{subtotal:.2f}' if first else '', 'Shipping': f'{shipping:.2f}' if first else '', 'Taxes': f'{round((total - shipping) / 6, 2):.2f}' if first else '',
                'Total': f'{total:.2f}' if first else '', 'Discount Code': code if first else '', 'Discount Amount': f'{disc:.2f}' if first else '',
                'Refunded Amount': f'{refunded:.2f}' if first else '', 'Created at': when.strftime('%Y-%m-%d %H:%M:%S +0000'),
                'Lineitem quantity': qty, 'Lineitem name': name, 'Lineitem price': f'{price:.2f}', 'Product Type': ptype,
                'Billing City': random.choice(cities) if first else '', 'Billing Country': country if first else '',
            })
with open(os.path.join(OUT, 'shopify_orders.csv'), 'w', newline='') as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
print('shopify', len(rows))
