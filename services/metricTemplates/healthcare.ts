import { MetricTemplate, IN, m } from './types';
const I = 'healthcare';
export const HEALTHCARE_TEMPLATES: MetricTemplate[] = [
  // ── Revenue & Billing ──
  m(I,'billing','net_patient_revenue','Net Patient Revenue','Revenue after adjustments.','💰','charges − adjustments',[IN.a('Total Charges','a'),IN.a('Adjustments','b')],({a,b})=>a-(b||0),'currency'),
  m(I,'billing','revenue_per_patient','Revenue Per Patient','Avg revenue per patient.','💲','revenue / patients',[IN.rev(),IN.a('Patient Count','b')],({revenue,b})=>b===0?null:revenue/b,'currency','AVG','non_additive'),
  m(I,'billing','collection_rate','Collection Rate %','Collected vs billed.','💳','collected/billed×100',[IN.a('Collected','a'),IN.a('Billed','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'billing','denial_rate','Denial Rate %','Claims denied.','❌','denied/submitted×100',[IN.a('Denied Claims','a'),IN.a('Submitted Claims','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'billing','net_collection_rate','Net Collection Rate %','Net collected vs allowed.','✅','collected/allowed×100',[IN.a('Net Collections','a'),IN.a('Allowed Amount','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'billing','charge_per_visit','Charge Per Visit','Avg charge per encounter.','🏥','charges / visits',[IN.a('Total Charges','a'),IN.a('Visits','b')],({a,b})=>b===0?null:a/b,'currency','AVG','non_additive'),
  m(I,'billing','payment_per_claim','Avg Payment Per Claim','Avg reimbursement.','💵','payments / claims',[IN.a('Total Payments','a'),IN.a('Claims','b')],({a,b})=>b===0?null:a/b,'currency','AVG','non_additive'),
  m(I,'billing','write_off_rate','Write-Off Rate %','Uncollectable charges.','📉','write_offs/charges×100',[IN.a('Write-Offs','a'),IN.a('Total Charges','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),

  // ── Cost & Efficiency ──
  m(I,'cost','cost_per_patient','Cost Per Patient','Total cost per patient.','💸','total_cost / patients',[IN.a('Total Cost','a'),IN.a('Patients','b')],({a,b})=>b===0?null:a/b,'currency','AVG','non_additive'),
  m(I,'cost','cost_per_bed_day','Cost Per Bed Day','Daily bed cost.','🛏️','cost / bed_days',[IN.a('Total Cost','a'),IN.a('Bed Days','b')],({a,b})=>b===0?null:a/b,'currency','AVG','non_additive'),
  m(I,'cost','cost_per_procedure','Cost Per Procedure','Avg procedure cost.','🔬','cost / procedures',[IN.a('Total Cost','a'),IN.a('Procedures','b')],({a,b})=>b===0?null:a/b,'currency','AVG','non_additive'),
  m(I,'cost','operating_margin','Operating Margin %','Profit margin.','📊','(rev−cost)/rev×100',[IN.rev(),IN.cost('Operating Cost')],({revenue,cost})=>revenue===0?null:((revenue-cost)/revenue)*100,'percent','AVG','non_additive'),
  m(I,'cost','labor_cost_per_patient','Labor Cost/Patient','Staff cost per patient.','👩‍⚕️','labor/patients',[IN.a('Labor Cost','a'),IN.a('Patients','b')],({a,b})=>b===0?null:a/b,'currency','AVG','non_additive'),
  m(I,'cost','supply_cost_ratio','Supply Cost %','Supplies as % of revenue.','📦','supplies/revenue×100',[IN.a('Supply Cost','a'),IN.rev()],({a,revenue})=>revenue===0?null:(a/revenue)*100,'percent','AVG','non_additive'),

  // ── Capacity & Utilization ──
  m(I,'capacity','bed_occupancy_rate','Bed Occupancy Rate %','Beds occupied.','🛏️','occupied/available×100',[IN.a('Occupied Beds','a'),IN.a('Available Beds','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'capacity','bed_turnover','Bed Turnover Rate','Patients per bed.','🔄','discharges / beds',[IN.a('Discharges','a'),IN.a('Beds','b')],({a,b})=>b===0?null:a/b,'number','AVG','non_additive'),
  m(I,'capacity','or_utilization','OR Utilization %','Operating room usage.','🏥','used_minutes/available_minutes×100',[IN.a('Used OR Minutes','a'),IN.a('Available OR Minutes','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'capacity','appointment_fill_rate','Appointment Fill %','Slots filled.','📅','booked/available×100',[IN.a('Booked Slots','a'),IN.a('Available Slots','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'capacity','patient_per_nurse','Patient-to-Nurse Ratio','Patients per nurse.','👩‍⚕️','patients / nurses',[IN.a('Patients','a'),IN.a('Nurses','b')],({a,b})=>b===0?null:a/b,'number','AVG','non_additive'),
  m(I,'capacity','er_boarding_hours','ER Boarding Hours','ED wait × patients.','⏰','wait_hours × patients',[IN.a('Avg Wait Hours','a'),IN.a('ER Patients','b')],({a,b})=>a*b,'number'),

  // ── Quality & Outcomes ──
  m(I,'quality','mortality_rate','Mortality Rate %','Deaths per admissions.','💀','deaths/admissions×100',[IN.a('Deaths','a'),IN.a('Admissions','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'quality','readmission_rate','Readmission Rate %','30-day readmissions.','🔁','readmit/discharges×100',[IN.a('Readmissions','a'),IN.a('Discharges','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'quality','complication_rate','Complication Rate %','Procedures with complications.','⚠️','complications/procedures×100',[IN.a('Complications','a'),IN.a('Procedures','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'quality','infection_rate','Infection Rate %','Hospital-acquired infections.','🦠','infections/patient_days×1000',[IN.a('Infections','a'),IN.a('Patient Days','b')],({a,b})=>b===0?null:(a/b)*1000,'number','AVG','non_additive'),
  m(I,'quality','fall_rate','Fall Rate','Falls per patient days.','🤕','falls/patient_days×1000',[IN.a('Falls','a'),IN.a('Patient Days','b')],({a,b})=>b===0?null:(a/b)*1000,'number','AVG','non_additive'),
  m(I,'quality','patient_satisfaction','Patient Satisfaction Score','Weighted satisfaction.','😊','(score×responses)/responses',[IN.a('Satisfaction Score','a'),IN.a('Responses','b')],({a,b})=>a,'number','AVG','non_additive'),
  m(I,'quality','case_mix_index','Case Mix Index','Avg DRG weight.','📊','total_weight / cases',[IN.a('Total DRG Weight','a'),IN.a('Cases','b')],({a,b})=>b===0?null:a/b,'number','AVG','non_additive'),

  // ── Staffing ──
  m(I,'staffing','staff_per_bed','Staff Per Bed','FTEs per bed.','👥','staff / beds',[IN.a('Staff FTEs','a'),IN.a('Beds','b')],({a,b})=>b===0?null:a/b,'number','AVG','non_additive'),
  m(I,'staffing','overtime_ratio','Overtime Ratio %','OT as % of total hours.','⏰','ot/total×100',[IN.a('OT Hours','a'),IN.a('Total Hours','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'staffing','agency_staff_pct','Agency Staff %','Temp/agency workers.','🏢','agency/total×100',[IN.a('Agency Staff','a'),IN.a('Total Staff','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'staffing','nurse_turnover','Nurse Turnover %','Nursing staff exits.','🚪','exits/avg_nurses×100',[IN.a('Nurse Exits','a'),IN.a('Avg Nurses','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'staffing','training_hours_per_staff','Training Hours/Staff','Training investment.','📚','total_hours / staff',[IN.a('Training Hours','a'),IN.a('Staff Count','b')],({a,b})=>b===0?null:a/b,'number','AVG','non_additive'),

  // ── Patient Flow ──
  m(I,'flow','avg_length_of_stay','Avg Length of Stay','Days per admission.','📅','total_days / discharges',[IN.a('Total Patient Days','a'),IN.a('Discharges','b')],({a,b})=>b===0?null:a/b,'number','AVG','non_additive'),
  m(I,'flow','ed_wait_index','ED Wait Index','Wait time × volume.','⏱️','wait_time × ed_visits',[IN.a('Avg Wait (min)','a'),IN.a('ED Visits','b')],({a,b})=>a*b,'number'),
  m(I,'flow','door_to_doc','Door-to-Doc Minutes','Arrival to physician.','🚪','total_wait / patients',[IN.a('Total Wait Min','a'),IN.a('ED Patients','b')],({a,b})=>b===0?null:a/b,'number','AVG','non_additive'),
  m(I,'flow','discharge_rate','Discharge Rate %','Discharges per admissions.','📤','discharges/admissions×100',[IN.a('Discharges','a'),IN.a('Admissions','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'flow','transfer_rate','Transfer Rate %','Transferred out.','🔄','transfers/admissions×100',[IN.a('Transfers','a'),IN.a('Admissions','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),

  // ── Pharmacy & Supply ──
  m(I,'pharmacy','drug_cost_per_patient','Drug Cost/Patient','Medication cost.','💊','drug_cost / patients',[IN.a('Drug Cost','a'),IN.a('Patients','b')],({a,b})=>b===0?null:a/b,'currency','AVG','non_additive'),
  m(I,'pharmacy','generic_rate','Generic Usage %','Generic vs brand drugs.','🏷️','generic/total×100',[IN.a('Generic Scripts','a'),IN.a('Total Scripts','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'pharmacy','supply_waste_pct','Supply Waste %','Wasted supplies.','🗑️','wasted/total×100',[IN.a('Wasted Value','a'),IN.a('Total Supply Value','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'pharmacy','formulary_compliance','Formulary Compliance %','On-formulary prescriptions.','📋','on_form/total×100',[IN.a('On-Formulary','a'),IN.a('Total Prescriptions','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'pharmacy','med_error_rate','Medication Error Rate','Errors per 1000 doses.','⚠️','errors/doses×1000',[IN.a('Med Errors','a'),IN.a('Total Doses','b')],({a,b})=>b===0?null:(a/b)*1000,'number','AVG','non_additive'),

  // ── Insurance & Payer ──
  m(I,'payer','payer_mix_revenue','Payer Revenue Share','Revenue from payer type.','🏦','payer_rev / total_rev × 100',[IN.a('Payer Revenue','a'),IN.rev('Total Revenue')],({a,revenue})=>revenue===0?null:(a/revenue)*100,'percent','AVG','non_additive'),
  m(I,'payer','days_in_ar','Days in A/R','Receivables aging.','📅','ar_balance / (revenue/365)',[IN.a('AR Balance','a'),IN.rev()],({a,revenue})=>revenue===0?null:a/(revenue/365),'number','AVG','non_additive'),
  m(I,'payer','clean_claim_rate','Clean Claim Rate %','Claims without errors.','✅','clean/total×100',[IN.a('Clean Claims','a'),IN.a('Total Claims','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'payer','contractual_adjustment','Contractual Adjustment %','Payer adjustments.','📄','adjustments/charges×100',[IN.a('Adjustments','a'),IN.a('Total Charges','b')],({a,b})=>b===0?null:(a/b)*100,'percent','AVG','non_additive'),
  m(I,'payer','cost_to_charge','Cost-to-Charge Ratio','Cost vs charge ratio.','📐','cost/charges×100',[IN.cost('Total Cost'),IN.a('Total Charges','b')],({cost,b})=>b===0?null:(cost/b)*100,'percent','AVG','non_additive'),
];
