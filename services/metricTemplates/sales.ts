import { MetricTemplate, IN, m } from './types';
const I = 'sales';
export const SALES_TEMPLATES: MetricTemplate[] = [
  // ── Revenue & Pricing ──
  m(I,'revenue','total_sales','Total Sales','Revenue from sold units.','💵','price × qty',[IN.price(),IN.qty()],({price,qty})=>price*qty,'currency'),
  m(I,'revenue','gross_revenue','Gross Revenue','Total revenue before deductions.','💰','price × qty',[IN.price('Selling Price'),IN.qty()],({price,qty})=>price*qty,'currency'),
  m(I,'revenue','net_revenue','Net Revenue','Revenue after discounts.','💳','price × qty × (1−disc/100)',[IN.price(),IN.qty(),IN.disc()],({price,qty,discount})=>price*qty*(1-(discount||0)/100),'currency'),
  m(I,'revenue','line_total','Line Item Total','Total for a single line item.','📝','price × qty',[IN.price('Item Price'),IN.qty('Line Qty')],({price,qty})=>price*qty,'currency'),
  m(I,'revenue','tax_amount','Tax Amount','Tax charged per transaction.','🏛️','revenue × tax_rate/100',[IN.rev(),IN.a('Tax Rate %','rate')],({revenue,rate})=>revenue*(rate||0)/100,'currency'),
  m(I,'revenue','revenue_with_tax','Revenue Incl. Tax','Revenue including tax.','💲','revenue × (1+tax/100)',[IN.rev(),IN.a('Tax Rate %','rate')],({revenue,rate})=>revenue*(1+(rate||0)/100),'currency'),
  m(I,'revenue','avg_selling_price','Avg Selling Price','Average price per unit.','🏷️','revenue / qty',[IN.rev(),IN.qty()],({revenue,qty})=>qty===0?null:revenue/qty,'currency','AVG','non_additive'),
  m(I,'revenue','price_variance','Price Variance','Difference from list price.','📊','actual − list',[IN.a('Actual Price','actual'),IN.a('List Price','target')],({actual,target})=>actual-target,'currency','SUM'),
  m(I,'revenue','price_variance_pct','Price Variance %','Percent deviation from list.','📉','(actual−list)/list×100',[IN.a('Actual Price','actual'),IN.a('List Price','target')],({actual,target})=>target===0?null:((actual-target)/target)*100,'percent','AVG','non_additive'),
  m(I,'revenue','shipping_revenue','Shipping Revenue','Revenue from shipping charges.','🚚','ship_price × qty',[IN.a('Shipping Price','a'),IN.qty()],({a,qty})=>a*qty,'currency'),

  // ── Profitability ──
  m(I,'profit','gross_profit','Gross Profit','Revenue minus COGS.','📈','(price−cost) × qty',[IN.price(),IN.cost('Cost Price'),IN.qty()],({price,cost,qty})=>(price-cost)*qty,'currency'),
  m(I,'profit','net_profit','Net Profit','Profit after all deductions.','💎','revenue − total_cost',[IN.rev(),IN.cost('Total Cost')],({revenue,cost})=>revenue-cost,'currency'),
  m(I,'profit','profit_margin_pct','Profit Margin %','Profit as % of revenue.','📉','(price−cost)/price×100',[IN.price(),IN.cost()],({price,cost})=>price===0?null:((price-cost)/price)*100,'percent','AVG','non_additive'),
  m(I,'profit','gross_margin','Gross Margin','Gross profit per unit.','🎯','price − cost',[IN.price(),IN.cost()],({price,cost})=>price-cost,'currency'),
  m(I,'profit','contribution_margin','Contribution Margin','Revenue minus variable costs.','🔥','price − variable_cost',[IN.price(),IN.cost('Variable Cost')],({price,cost})=>price-cost,'currency'),
  m(I,'profit','contribution_margin_pct','Contribution Margin %','Contribution as % of price.','📐','(price−cost)/price×100',[IN.price(),IN.cost('Variable Cost')],({price,cost})=>price===0?null:((price-cost)/price)*100,'percent','AVG','non_additive'),
  m(I,'profit','operating_profit','Operating Profit','Profit minus operating expenses.','⚙️','gross_profit − opex',[IN.a('Gross Profit','a'),IN.a('Operating Expense','b')],({a,b})=>a-b,'currency'),
  m(I,'profit','ebitda_proxy','EBITDA Proxy','Operating profit + depreciation.','🏦','op_profit + depreciation',[IN.a('Operating Profit','a'),IN.a('Depreciation','b')],({a,b})=>a+b,'currency'),
  m(I,'profit','profit_per_unit','Profit Per Unit','Net profit per unit sold.','💵','profit / qty',[IN.a('Net Profit','a'),IN.qty()],({a,qty})=>qty===0?null:a/qty,'currency','AVG','non_additive'),
  m(I,'profit','break_even_units','Break-Even Units','Units needed to cover fixed cost.','🎲','fixed_cost / (price−cost)',[IN.a('Fixed Cost','a'),IN.price(),IN.cost()],({a,price,cost})=>(price-cost)===0?null:a/(price-cost),'integer','SUM','non_additive'),

  // ── Cost ──
  m(I,'cost','cogs','Cost of Goods Sold','Total COGS per line.','🏭','cost × qty',[IN.cost('Unit Cost'),IN.qty()],({cost,qty})=>cost*qty,'currency'),
  m(I,'cost','total_expense','Total Expense','Sum of cost components.','💸','cost_a + cost_b',[IN.a('Cost Component A','a'),IN.a('Cost Component B','b')],({a,b})=>a+b,'currency'),
  m(I,'cost','cost_ratio','Cost Ratio','Cost as % of revenue.','📊','cost/revenue×100',[IN.cost(),IN.rev()],({cost,revenue})=>revenue===0?null:(cost/revenue)*100,'percent','AVG','non_additive'),
  m(I,'cost','markup_pct','Markup %','Markup over cost.','📐','(price−cost)/cost×100',[IN.price(),IN.cost()],({price,cost})=>cost===0?null:((price-cost)/cost)*100,'percent','AVG','non_additive'),
  m(I,'cost','markup_amount','Markup Amount','Dollar markup per unit.','💲','price − cost',[IN.price(),IN.cost()],({price,cost})=>price-cost,'currency'),

  // ── Discounts ──
  m(I,'discount','discount_impact','Discount Impact','Revenue lost to discounts.','🏷️','price×qty×disc/100',[IN.price(),IN.qty(),IN.disc()],({price,qty,discount})=>price*qty*((discount||0)/100),'currency'),
  m(I,'discount','effective_price','Effective Price','Price after discount.','🔖','price×(1−disc/100)',[IN.price(),IN.disc()],({price,discount})=>price*(1-(discount||0)/100),'currency'),
  m(I,'discount','discount_amount','Discount Amount','Per-unit discount value.','💲','price × disc/100',[IN.price(),IN.disc()],({price,discount})=>price*((discount||0)/100),'currency'),
  m(I,'discount','net_discount_margin','Net Discount Margin','Margin after discount.','📉','eff_price − cost',[IN.a('Effective Price','a'),IN.cost()],({a,cost})=>a-cost,'currency'),
  m(I,'discount','discount_depth','Discount Depth','Discount as % of list.','🎚️','(list−sell)/list×100',[IN.a('List Price','a'),IN.a('Sell Price','b')],({a,b})=>a===0?null:((a-b)/a)*100,'percent','AVG','non_additive'),

  // ── Unit Economics ──
  m(I,'unit_economics','revenue_per_unit','Revenue Per Unit','Avg revenue per unit.','💲','revenue / qty',[IN.rev(),IN.qty()],({revenue,qty})=>qty===0?null:revenue/qty,'currency','AVG','non_additive'),
  m(I,'unit_economics','cost_per_unit','Cost Per Unit','Avg cost per unit.','🏷️','total_cost / qty',[IN.cost('Total Cost'),IN.qty()],({cost,qty})=>qty===0?null:cost/qty,'currency','AVG','non_additive'),
  m(I,'unit_economics','profit_per_item','Profit Per Item','Profit on each item.','💎','(price−cost)×qty_ratio',[IN.price(),IN.cost()],({price,cost})=>price-cost,'currency'),
  m(I,'unit_economics','value_density','Value Density','Revenue per unit weight.','⚖️','revenue / weight',[IN.rev(),IN.a('Weight','b')],({revenue,b})=>b===0?null:revenue/b,'currency','AVG','non_additive'),
  m(I,'unit_economics','basket_value','Basket Value','Total transaction value.','🛒','price × qty',[IN.price(),IN.qty()],({price,qty})=>price*qty,'currency'),

  // ── Performance ──
  m(I,'performance','target_achievement','Target Achievement %','Actual vs target.','🎯','(actual/target)×100',[IN.actual('Actual Sales'),IN.target('Sales Target')],({actual,target})=>target===0?null:(actual/target)*100,'percent','AVG','non_additive'),
  m(I,'performance','quota_gap','Quota Gap','Distance from quota.','📏','actual − target',[IN.actual('Actual'),IN.target('Quota')],({actual,target})=>actual-target,'currency'),
  m(I,'performance','over_under_pct','Over/Under %','% above or below target.','📈','(actual−target)/target×100',[IN.actual(),IN.target()],({actual,target})=>target===0?null:((actual-target)/target)*100,'percent','AVG','non_additive'),
  m(I,'performance','conversion_value','Conversion Value','Revenue from converted leads.','🔄','leads × conv_rate × avg_deal',[IN.a('Leads','a'),IN.a('Conv Rate %','b'),IN.a('Avg Deal Size','c')],({a,b,c})=>a*(b/100)*c,'currency'),
  m(I,'performance','win_value','Deal Win Value','Value of won deals.','🏆','deal_value × win_flag',[IN.a('Deal Value','a'),IN.a('Win Flag (1/0)','b')],({a,b})=>a*b,'currency'),

  // ── Commission & Compensation ──
  m(I,'commission','commission_earned','Commission Earned','Commission on sale.','💼','revenue × comm_rate/100',[IN.rev(),IN.a('Commission Rate %','rate')],({revenue,rate})=>revenue*(rate||0)/100,'currency'),
  m(I,'commission','commission_after_tax','Net Commission','Commission after tax.','💰','commission × (1−tax/100)',[IN.a('Commission','a'),IN.a('Tax Rate %','rate')],({a,rate})=>a*(1-(rate||0)/100),'currency'),
  m(I,'commission','bonus_amount','Bonus Amount','Performance bonus earned.','🎁','base × multiplier',[IN.a('Base Bonus','a'),IN.a('Multiplier','b')],({a,b})=>a*b,'currency'),
  m(I,'commission','total_comp','Total Compensation','Salary plus commission.','👔','salary + commission',[IN.a('Base Salary','a'),IN.a('Commission','b')],({a,b})=>a+b,'currency'),
  m(I,'commission','comp_ratio','Comp-to-Revenue %','Compensation as % of revenue.','📊','comp/revenue×100',[IN.a('Total Comp','a'),IN.rev()],({a,revenue})=>revenue===0?null:(a/revenue)*100,'percent','AVG','non_additive'),

  // ── Forecasting ──
  m(I,'forecast','forecast_accuracy','Forecast Accuracy %','How close forecast was.','🔮','(1−|actual−forecast|/actual)×100',[IN.actual(),IN.a('Forecast','b')],({actual,b})=>actual===0?null:(1-Math.abs(actual-b)/actual)*100,'percent','AVG','non_additive'),
  m(I,'forecast','forecast_bias','Forecast Bias','Systematic over/under forecast.','📐','actual − forecast',[IN.actual(),IN.a('Forecast','b')],({actual,b})=>actual-b,'number','AVG'),
  m(I,'forecast','weighted_pipeline','Weighted Pipeline','Pipeline weighted by probability.','⚖️','deal_value × probability/100',[IN.a('Deal Value','a'),IN.a('Win Probability %','b')],({a,b})=>a*(b||0)/100,'currency'),
  m(I,'forecast','pipeline_coverage','Pipeline Coverage Ratio','Pipeline vs quota.','📏','pipeline / quota',[IN.a('Pipeline Value','a'),IN.target('Quota')],({a,target})=>target===0?null:a/target,'number','AVG','non_additive'),
  m(I,'forecast','days_to_close_value','Daily Deal Value','Deal value prorated by days.','📅','value / days',[IN.a('Deal Value','a'),IN.days('Days to Close')],({a,days})=>days===0?null:a/days,'currency','AVG','non_additive'),
];
