import csv, io, random, datetime as dt
R = random.Random(7)
def w(name, header, rows, pre=None):
    buf = io.StringIO()
    if pre:
        for line in pre: buf.write(line + '\n')
    cw = csv.writer(buf); cw.writerow(header); cw.writerows(rows)
    open(name, 'w').write(buf.getvalue())
money = lambda v: f"£{v:,.2f}" if v >= 0 else f"-£{-v:,.2f}"
d0 = dt.date(2025, 1, 1)

# 1 Square item sales
rows = []
for i in range(400):
    d = d0 + dt.timedelta(days=R.randrange(0, 120)); qty = R.choice([1, 1, 2, 3]); price = R.choice([2.5, 3.2, 4.0, 6.5])
    gross = qty * price; disc = -round(gross * 0.1, 2) if R.random() < 0.15 else 0.0
    refund = R.random() < 0.04
    rows.append([d.isoformat(), f"{R.randrange(7, 19):02d}:{R.randrange(60):02d}:00", 'Europe/London', R.choice(['Coffee', 'Bakery', 'Tea']), R.choice(['Latte', 'Flat White', 'Croissant', 'Chai']), -qty if refund else qty, 'Regular', f"SKU{R.randrange(100, 120)}", '', money(-gross if refund else gross), money(disc), money((-gross if refund else gross) + disc), money(round(((-gross if refund else gross) + disc) / 6, 2)), f"T{i:05d}", f"P{i:05d}", 'Counter iPad', '', '', 'Refund' if refund else 'Payment', R.choice(['High St', 'Station']), 'For Here', f"C{R.randrange(1, 90):03d}" if R.random() < 0.6 else '', 'Square Point of Sale', R.choice(['Visa', 'Mastercard', 'Cash'])])
w('square_item_sales.csv', ['Date', 'Time', 'Time Zone', 'Category', 'Item', 'Qty', 'Price Point Name', 'SKU', 'Modifiers Applied', 'Gross Sales', 'Discounts', 'Net Sales', 'Tax', 'Transaction ID', 'Payment ID', 'Device Name', 'Notes', 'Details', 'Event Type', 'Location', 'Dining Option', 'Customer ID', 'Channel', 'Card Brand'], rows)

# 2 Shopify orders (order fields only on first line of each order)
rows = []; n = 1000
for o in range(150):
    n += 1; lines = R.choice([1, 1, 2, 3]); created = dt.datetime(2025, 3, 1) + dt.timedelta(hours=R.randrange(0, 1400))
    items = [(R.choice(['Mug', 'Tote Bag', 'Print A4', 'Notebook']), R.choice([8.0, 12.0, 15.0, 6.5]), R.choice([1, 1, 2])) for _ in range(lines)]
    sub = sum(p * q for _, p, q in items); ship = 3.95; tax = round(sub / 6, 2); status = R.choice(['paid'] * 9 + ['refunded'])
    for k, (name, price, q) in enumerate(items):
        first = k == 0
        rows.append([f"#{n}", f"c{o}@example.com" if first else '', status if first else '', created.strftime('%Y-%m-%d %H:%M:%S +0000') if first else '', 'fulfilled' if first else '', 'yes' if first and R.random() < .4 else ('no' if first else ''), 'GBP' if first else '', f"{sub:.2f}" if first else '', f"{ship:.2f}" if first else '', f"{tax:.2f}" if first else '', f"{sub + ship:.2f}" if first else '', '', '0.00' if first else '', created.strftime('%Y-%m-%d %H:%M:%S +0000'), q, name, f"{price:.2f}", '', f"SKU-{name[:3].upper()}", 'true', 'true', 'fulfilled', R.choice(['London', 'Leeds', 'Bristol']) if first else '', 'GB' if first else ''])
w('shopify_orders_export.csv', ['Name', 'Email', 'Financial Status', 'Paid at', 'Fulfillment Status', 'Accepts Marketing', 'Currency', 'Subtotal', 'Shipping', 'Taxes', 'Total', 'Discount Code', 'Discount Amount', 'Created at', 'Lineitem quantity', 'Lineitem name', 'Lineitem price', 'Lineitem compare at price', 'Lineitem sku', 'Lineitem requires shipping', 'Lineitem taxable', 'Lineitem fulfillment status', 'Billing City', 'Billing Country'], rows)

# 3 Stripe payments
rows = []
for i in range(300):
    amt = R.choice([9.99, 19.99, 49.0, 99.0]); status = R.choice(['Paid'] * 18 + ['Failed', 'Refunded'])
    rows.append([f"ch_3P{R.randrange(10**9):09d}", 'Subscription update', (dt.datetime(2025, 2, 1) + dt.timedelta(hours=R.randrange(2000))).strftime('%Y-%m-%d %H:%M'), f"{amt:.2f}", f"{amt:.2f}" if status == 'Refunded' else '0.00', 'gbp', f"{amt:.2f}", f"{round(amt * 0.015 + 0.2, 2):.2f}", status, f"user{R.randrange(200)}@mail.com", R.choice(['visa', 'mastercard', 'amex']), 'GB'])
w('stripe_payments.csv', ['id', 'Description', 'Created date (UTC)', 'Amount', 'Amount Refunded', 'Currency', 'Converted Amount', 'Fee', 'Status', 'Customer Email', 'Card Brand', 'Card Issue Country'], rows)

# 4 SumUp (EU decimals, dd.mm.yyyy)
rows = []
for i in range(200):
    t = dt.datetime(2025, 4, 1, 9) + dt.timedelta(minutes=R.randrange(0, 60 * 24 * 40))
    amt = R.choice([3.5, 7.2, 12.9, 24.0, 150.0]); tip = R.choice([0, 0, 0.5, 1.0])
    rows.append([f"TX{i:06d}", t.strftime('%d.%m.%Y %H:%M'), 'Card', R.choice(['Successful'] * 19 + ['Failed']), R.choice(['VISA', 'MASTERCARD']), f"{amt:.2f}".replace('.', ','), f"{tip:.2f}".replace('.', ','), f"{amt * 0.0169:.2f}".replace('.', ','), 'EUR'])
open('sumup_transactions.csv', 'w').write('Transaction ID;Date;Payment type;Status;Card type;Total amount;Tip amount;Fee;Currency\n' + '\n'.join(';'.join(r) for r in rows) + '\n')

# 5 UK bank statement (dd/mm/yyyy, paid in/out, balance)
rows = []; bal = 5000.0
for i in range(180):
    d = d0 + dt.timedelta(days=i // 2)
    if R.random() < 0.4: amt = round(R.uniform(50, 900), 2); bal += amt; rows.append([d.strftime('%d/%m/%Y'), 'CR', R.choice(['SQUARE PAYOUT', 'STRIPE PAYOUT', 'TRANSFER IN']), '', money(amt), money(bal)])
    else: amt = round(R.uniform(5, 400), 2); bal -= amt; rows.append([d.strftime('%d/%m/%Y'), 'DEB', R.choice(['BRAKES FOODS', 'EDF ENERGY', 'HMRC VAT', 'BT GROUP', 'RENT']), money(amt), '', money(bal)])
w('bank_statement.csv', ['Date', 'Type', 'Description', 'Paid out', 'Paid in', 'Balance'], rows)

# 6 QuickBooks P&L report (title lines, sections, totals, months as columns)
months = ['Jan 2025', 'Feb 2025', 'Mar 2025', 'Apr 2025']
def line(name, vals): return [name] + [f"{v:,.2f}" for v in vals] + [f"{sum(vals):,.2f}"]
sales = [R.uniform(8000, 12000) for _ in months]; other = [R.uniform(100, 400) for _ in months]
cogs = [s * 0.4 for s in sales]; wages = [R.uniform(2500, 3000) for _ in months]; rent = [1500.0] * 4
rows = [['Income'] + [''] * 5, line('  Sales', sales), line('  Other Income', other), line('Total Income', [a + b for a, b in zip(sales, other)]),
        ['Cost of Sales'] + [''] * 5, line('  Cost of Goods Sold', cogs), line('Total Cost of Sales', cogs),
        line('Gross Profit', [a + b - c for a, b, c in zip(sales, other, cogs)]),
        ['Expenses'] + [''] * 5, line('  Wages', wages), line('  Rent', rent), line('Total Expenses', [a + b for a, b in zip(wages, rent)]),
        line('Net Income', [a + b - c - d - e for a, b, c, d, e in zip(sales, other, cogs, wages, rent)])]
w('quickbooks_profit_and_loss.csv', [''] + months + ['Total'], rows, pre=['Corner Cafe Ltd', 'Profit and Loss', 'January - April 2025', ''])

# 7 Inventory
rows = [[f"SKU{i:03d}", R.choice(['Latte Cups', 'Oat Milk 1L', 'Coffee Beans 1kg', 'Napkins', 'Croissant (frozen)']) + f" {i}", R.choice(['Packaging', 'Dairy', 'Coffee', 'Bakery']), R.randrange(0, 200), R.choice([10, 20, 50]), f"£{R.uniform(0.1, 18):.2f}", R.choice(['Brakes', 'Bidfood', 'Local Roaster']), (d0 + dt.timedelta(days=R.randrange(0, 90))).strftime('%d/%m/%Y')] for i in range(120)]
w('inventory.csv', ['SKU', 'Product', 'Category', 'Stock on hand', 'Reorder level', 'Unit cost', 'Supplier', 'Last counted'], rows)

# 8 Survey
scale = ['Very dissatisfied', 'Dissatisfied', 'Neutral', 'Satisfied', 'Very satisfied']
rows = [[f"R{i:04d}", (dt.datetime(2025, 5, 1) + dt.timedelta(hours=R.randrange(800))).strftime('%Y-%m-%d %H:%M'), R.randrange(0, 11), R.choice(scale), R.choice(['Yes', 'No']), R.choice(['18-24', '25-34', '35-44', '45-54', '55+']), R.choice(['', 'Great coffee', 'Queue too long', 'Friendly staff', 'Too expensive'])] for i in range(250)]
w('customer_survey.csv', ['Response ID', 'Submitted at', 'How likely are you to recommend us? (0-10)', 'Overall satisfaction', 'Would visit again', 'Age band', 'Comments'], rows)

# 9 Marketing
rows = []
for c in ['Spring Sale', 'Loyalty', 'New Menu']:
    for ch in ['Facebook', 'Instagram', 'Google']:
        for wk in range(8):
            imp = R.randrange(2000, 20000); clk = int(imp * R.uniform(0.01, 0.04)); spend = round(clk * R.uniform(0.2, 0.9), 2); conv = int(clk * R.uniform(0.02, 0.1))
            rows.append([c, ch, (d0 + dt.timedelta(weeks=wk)).isoformat(), imp, clk, f"{100 * clk / imp:.2f}%", f"£{spend:,.2f}", conv, f"£{spend / clk:.2f}"])
w('marketing_campaigns.csv', ['Campaign', 'Channel', 'Week starting', 'Impressions', 'Clicks', 'CTR', 'Spend', 'Conversions', 'CPC'], rows)

# 10 Timesheets (durations)
rows = []
for i in range(160):
    start = R.choice(['07:00', '08:30', '09:00', '12:00']); hrs = R.choice([4, 6, 7.5, 8]); h, m = map(int, start.split(':')); end = f"{h + int(hrs):02d}:{m + int((hrs % 1) * 60):02d}"
    rows.append([R.choice(['Amy Lee', 'Ben Cho', 'Cara Diaz', 'Dev Patel']), (d0 + dt.timedelta(days=i // 4)).strftime('%d/%m/%Y'), start, end, f"{int(hrs)}:{int((hrs % 1) * 60):02d}", f"£{R.choice([11.44, 12.5, 14.0]):.2f}", R.choice(['Barista', 'Kitchen', 'Manager'])])
w('timesheets.csv', ['Employee', 'Date', 'Clock in', 'Clock out', 'Hours worked', 'Hourly rate', 'Role'], rows)

# 11 Messy hand-kept spreadsheet (title, blanks, N/A, totals)
rows = []
for i in range(60):
    rows.append([(d0 + dt.timedelta(days=i)).strftime(R.choice(['%d/%m/%Y', '%d %b %Y', '%Y-%m-%d'])), R.choice(['Cakes', 'cakes ', 'CAKES', 'Coffee', 'coffee']), R.choice(['', 'N/A']) if R.random() < 0.05 else f"{R.uniform(20, 300):.2f}", R.choice(['cash', 'Card', 'card', 'CARD'])])
rows.append(['Total', '', '', ''])
w('messy_daily_takings.csv', ['Date', 'What', 'Takings £', 'Paid by'], rows, pre=['Corner Cafe - daily takings (Sam)', ''])

# 12 Wide monthly sales by product
rows = [[p] + [f"{R.uniform(200, 900):.0f}" for _ in range(6)] for p in ['Latte', 'Flat White', 'Croissant', 'Chai', 'Muffin']]
w('monthly_sales_by_product.csv', ['Product', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'], rows)
print('ok')
