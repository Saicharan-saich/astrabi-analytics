import { MetricTemplate, IN, m } from './types';
const I = 'manufacturing';
export const MANUFACTURING_TEMPLATES: MetricTemplate[] = [
  // ── Production ──
  m(I,'production','total_output_value','Total Output Value','Value of goods produced.','🏭','units × unit_value',[IN.a('Units Produced','a'),IN.a('Unit Value','b')],({a,b})=>a*b,'currency'),
  m(I,'production','production_cost','Production Cost','Total cost of production.','💸','material + labor + overhead',[IN.a('Material Cost','a'),IN.a('Labor Cost','b'),IN.a('Overhead','c')],({a,b,c})=>a+b+(c||0),'currency'),
  m(I,'production','cost_per_unit','Cost Per Unit','Unit production cost.','💲','total_cost / units',[IN.a('Total Cost','a'),IN.a('Units Produced','b')],({a,b})=>b===0?null:a/b,'currency','AVG','non_additive'),
  m(I,'production','output_per_hour','Output Per Hour','Units per labor hour.','⏰','units / hours',[IN.a('Units','a'),IN.hours('Labor Hours')],({a,hours})=>hours===0?null:a/hours,'number','AVG','non_additive'),
  m(I,'production','cycle_time_efficiency','Cycle Time Efficiency %','Ideal vs actual cycle.','🔄','ideal/actual×100',[IN.a('Ideal Cycle Time','a'),IN.a('Actual Cycle Time','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'production','throughput_rate','Throughput Rate','Good units per hour.','📈','good_units / hours',[IN.a('Good Units','a'),IN.hours()],({a,hours})=>hours===0?null:a/hours,'number','AVG','non_additive'),
  m(I,'production','capacity_utilization','Capacity Utilization %','Used vs total capacity.','📊','actual/capacity×100',[IN.actual('Actual Output'),IN.a('Max Capacity','b')],({actual,b})=>b===0?null:(actual/b)*100,'percent','AVG','non_additive'),
  m(I,'production','production_variance','Production Variance','Actual vs planned.','📉','actual − planned',[IN.actual('Actual Units'),IN.a('Planned Units','b')],({actual,b})=>actual-b,'integer'),
  m(I,'production','changeover_loss','Changeover Loss','Time lost to changeovers.','⏱️','changeovers × avg_time',[IN.a('Number of Changeovers','a'),IN.a('Avg Changeover Min','b')],({a,b})=>a*b,'number'),
  m(I,'production','takt_time','Takt Time','Available time per unit.','🕐','available_time / demand',[IN.a('Available Time (min)','a'),IN.a('Customer Demand','b')],({a,b})=>b===0?null:a/b,'number','AVG','non_additive'),

  // ── Quality ──
  m(I,'quality','yield_rate','Yield Rate %','Good units produced.','✅','good/total×100',[IN.a('Good Units','a'),IN.a('Total Units','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'quality','defect_rate','Defect Rate %','Defective units.','❌','defects/total×100',[IN.a('Defects','a'),IN.a('Total Units','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'quality','scrap_rate','Scrap Rate %','Scrapped material.','🗑️','scrap/input×100',[IN.a('Scrap Qty','a'),IN.a('Input Qty','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'quality','rework_rate','Rework Rate %','Units needing rework.','🔧','rework/total×100',[IN.a('Rework Units','a'),IN.a('Total Units','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'quality','scrap_cost','Scrap Cost','Value of scrapped material.','💸','scrap_qty × material_cost',[IN.a('Scrap Qty','a'),IN.a('Material Cost/Unit','b')],({a,b})=>a*b,'currency'),
  m(I,'quality','rework_cost','Rework Cost','Cost of rework.','🔧','rework_units × rework_cost',[IN.a('Rework Units','a'),IN.a('Cost Per Rework','b')],({a,b})=>a*b,'currency'),
  m(I,'quality','cost_of_quality','Cost of Quality','Prevention+appraisal+failure.','📊','prevention + appraisal + failure',[IN.a('Prevention Cost','a'),IN.a('Appraisal Cost','b'),IN.a('Failure Cost','c')],({a,b,c})=>a+b+(c||0),'currency'),
  m(I,'quality','first_pass_yield','First Pass Yield %','Pass without rework.','🎯','first_pass/total×100',[IN.a('First Pass Good','a'),IN.a('Total Started','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'quality','return_rate','Customer Return Rate %','Products returned.','↩️','returns/shipped×100',[IN.a('Returns','a'),IN.a('Shipped','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'quality','ppm_defective','PPM Defective','Defects per million.','🔬','defects/total×1000000',[IN.a('Defects','a'),IN.a('Total Units','b')],({a,b})=>b===0?null:(a/b)*1000000,'integer','AVG','non_additive'),

  // ── OEE ──
  m(I,'oee','oee','OEE %','Overall Equipment Effectiveness.','⚙️','avail × perf × qual / 10000',[IN.a('Availability %','a'),IN.a('Performance %','b'),IN.a('Quality %','c')],({a,b,c})=>(a*b*c)/10000,'percent','AVG','non_additive'),
  m(I,'oee','availability','Availability %','Uptime percentage.','🟢','run_time/planned×100',[IN.a('Run Time','a'),IN.a('Planned Time','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'oee','performance_rate','Performance Rate %','Actual vs ideal speed.','🏎️','(ideal_cycle×units)/run_time×100',[IN.a('Ideal Cycle Time','a'),IN.a('Units','b'),IN.a('Run Time','c')],({a,b,c})=>c===0?null:((a*b)/c)*100,'percent','AVG','non_additive'),
  m(I,'oee','quality_rate','Quality Rate %','Good vs total produced.','✅','good/total×100',[IN.a('Good Units','a'),IN.a('Total Produced','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'oee','downtime_cost','Downtime Cost','Cost of unplanned stops.','🛑','downtime_hours × hourly_cost',[IN.a('Downtime Hours','a'),IN.a('Hourly Machine Cost','b')],({a,b})=>a*b,'currency'),

  // ── Inventory ──
  m(I,'inventory','inventory_turnover','Inventory Turnover','COGS / avg inventory.','🔄','cogs / avg_inventory',[IN.a('COGS','a'),IN.a('Avg Inventory Value','b')],({a,b})=>b===0?null:a/b,'number','AVG','non_additive'),
  m(I,'inventory','days_of_supply','Days of Supply','Inventory coverage days.','📅','inventory / (demand/365)',[IN.a('Inventory Value','a'),IN.a('Annual Demand Value','b')],({a,b})=>b===0?null:a/(b/365),'number','AVG','non_additive'),
  m(I,'inventory','carrying_cost','Carrying Cost','Annual holding cost.','💰','inventory × carry_rate/100',[IN.a('Inventory Value','a'),IN.a('Carrying Rate %','b')],({a,b})=>a*(b||0)/100,'currency'),
  m(I,'inventory','stockout_cost','Stockout Cost','Lost sales from stockouts.','📉','stockout_units × margin',[IN.a('Stockout Units','a'),IN.a('Unit Margin','b')],({a,b})=>a*b,'currency'),
  m(I,'inventory','wip_value','WIP Value','Work-in-progress value.','🏗️','wip_units × unit_cost',[IN.a('WIP Units','a'),IN.a('Unit Cost','b')],({a,b})=>a*b,'currency'),

  // ── Maintenance ──
  m(I,'maintenance','mtbf','MTBF (Hours)','Mean Time Between Failures.','⏰','total_uptime / failures',[IN.a('Total Uptime Hours','a'),IN.a('Number of Failures','b')],({a,b})=>b===0?null:a/b,'number','AVG','non_additive'),
  m(I,'maintenance','mttr','MTTR (Hours)','Mean Time To Repair.','🔧','total_repair_time / repairs',[IN.a('Total Repair Hours','a'),IN.a('Number of Repairs','b')],({a,b})=>b===0?null:a/b,'number','AVG','non_additive'),
  m(I,'maintenance','maintenance_cost_ratio','Maintenance Cost %','Maintenance vs asset value.','💸','maint_cost / asset_value × 100',[IN.a('Maintenance Cost','a'),IN.a('Asset Value','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'maintenance','planned_maint_pct','Planned Maintenance %','Planned vs total maintenance.','📋','planned/total×100',[IN.a('Planned Hours','a'),IN.a('Total Maint Hours','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'maintenance','maint_cost_per_unit','Maint Cost Per Unit','Maintenance per unit produced.','🔧','maint_cost / units',[IN.a('Maintenance Cost','a'),IN.a('Units Produced','b')],({a,b})=>b===0?null:a/b,'currency','AVG','non_additive'),

  // ── Energy & Sustainability ──
  m(I,'energy','energy_per_unit','Energy Per Unit','Energy consumption per unit.','⚡','kwh / units',[IN.a('kWh Consumed','a'),IN.a('Units Produced','b')],({a,b})=>b===0?null:a/b,'number','AVG','non_additive'),
  m(I,'energy','energy_cost_ratio','Energy Cost %','Energy as % of production.','💡','energy_cost/prod_cost×100',[IN.a('Energy Cost','a'),IN.a('Production Cost','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'energy','carbon_per_unit','Carbon Per Unit','CO2 per unit produced.','🌍','co2_kg / units',[IN.a('CO2 (kg)','a'),IN.a('Units','b')],({a,b})=>b===0?null:a/b,'number','AVG','non_additive'),
  m(I,'energy','waste_diversion_rate','Waste Diversion %','Recycled vs total waste.','♻️','recycled/total×100',[IN.a('Recycled','a'),IN.a('Total Waste','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'energy','water_per_unit','Water Per Unit','Water usage per unit.','💧','liters / units',[IN.a('Liters Used','a'),IN.a('Units','b')],({a,b})=>b===0?null:a/b,'number','AVG','non_additive'),

  // ── Safety ──
  m(I,'safety','incident_rate','Incident Rate','OSHA incident rate.','⚠️','incidents×200000/hours',[IN.a('Incidents','a'),IN.hours('Total Hours Worked')],({a,hours})=>hours===0?null:(a*200000)/hours,'number','AVG','non_additive'),
  m(I,'safety','lost_time_rate','Lost Time Rate','Lost days per incidents.','🤕','lost_days / incidents',[IN.a('Lost Days','a'),IN.a('Incidents','b')],({a,b})=>b===0?null:a/b,'number','AVG','non_additive'),
  m(I,'safety','safety_training_pct','Safety Training %','Trained employees.','📚','trained/total×100',[IN.a('Trained','a'),IN.a('Total Workers','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'safety','near_miss_ratio','Near Miss Ratio','Near misses vs incidents.','🎯','near_misses / incidents',[IN.a('Near Misses','a'),IN.a('Incidents','b')],({a,b})=>b===0?null:a/b,'number','AVG','non_additive'),
  m(I,'safety','safety_cost','Safety Cost Per Employee','Safety investment.','💰','safety_spend / workers',[IN.a('Safety Spend','a'),IN.a('Workers','b')],({a,b})=>b===0?null:a/b,'currency','AVG','non_additive'),
];
